#!/usr/bin/env python3
"""SwarmForge artifact capture helper.

This runs inside a worker guest as root and is the only code that opens
worker-owned paths. Every component is opened descriptor-relatively from a
pinned directory file descriptor with O_NOFOLLOW, so a component that is
replaced by a symlink between the check and the read is refused instead of
followed: there is no check-then-use window at all. Only regular files are
captured, and only through a pinned descriptor, so a FIFO never blocks the
helper and a device or socket is never read.

Bytes are copied into a private staging file while being hashed, and this
program writes exactly one small JSON object to stdout describing that file.
File contents never appear in this program's output, in its exit status or in
its error messages; an error names the rule that was refused, never the data.

Operations:
  list      describe one directory, bounded and sorted
  open      stage one regular file (or a window of it) with its SHA-256
  snapshot  stage a bounded tar.gz of regular files, never extracted
  capture   stage the bounded output of guest commands into a private file
"""

import errno
import gzip
import hashlib
import json
import os
import re
import select
import stat as statmod
import subprocess
import sys
import tarfile
import time

CHUNK = 1 << 18
DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
# O_NONBLOCK keeps a FIFO from parking the capture even if a bind mount slips
# past the descriptor walk; the descriptor is only ever read after S_ISREG.
FILE_FLAGS = os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK
WRITE_FLAGS = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC
NAME_RE = re.compile(r"\A[A-Za-z0-9][A-Za-z0-9._-]{0,63}\Z")
MAX_ARCNAME = 1024
# A helper message never quotes a file's contents, so it is small by
# construction; the bound here is a last resort for a pathological message, and
# it is applied only to text this program generates itself.
MAX_ERROR = 512
EXCLUDED = (".git", "node_modules")
MAX_SOURCES = 8
# Nothing inherited from the caller's environment: no secrets, no PYTHON* or
# GIT_* overrides, no locale surprises in the metadata.
# Nothing inherited from the caller's environment: no secrets, no PYTHON* or
# GIT_* overrides, no locale surprises in the metadata. The Git settings below are
# part of the capture's safety, not of its convenience: system and global
# configuration are switched off so a repository's own configuration is the only
# thing that can apply, and that configuration lives inside the pinned root.
CHILD_ENV = {
    "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    "HOME": "/root",
    "LC_ALL": "C",
    "GIT_OPTIONAL_LOCKS": "0",
    "GIT_TERMINAL_PROMPT": "0",
    "GIT_CONFIG_NOSYSTEM": "1",
    "GIT_CONFIG_GLOBAL": "/dev/null",
    "GIT_CONFIG_SYSTEM": "/dev/null",
    "GIT_ATTR_NOSYSTEM": "1",
    "GIT_DISCOVERY_ACROSS_FILESYSTEM": "0",
    "GIT_CEILING_DIRECTORIES": "/",
}


# A stable, comparable taxonomy. A caller classifies a refusal by this code and
# never by its English text: "absent" and "not a directory" are different
# outcomes for a salvage decision, and a network, permission or symlink failure
# is neither of them.
CODE_NOT_FOUND = "not_found"
CODE_NOT_DIRECTORY = "not_directory"
CODE_UNSAFE_PATH = "unsafe_path"
CODE_LIMIT_EXCEEDED = "limit_exceeded"
CODE_SOURCE_CHANGED = "source_changed"
CODE_TRANSPORT = "transport"

CODES = (
    CODE_NOT_FOUND,
    CODE_NOT_DIRECTORY,
    CODE_UNSAFE_PATH,
    CODE_LIMIT_EXCEEDED,
    CODE_SOURCE_CHANGED,
    CODE_TRANSPORT,
)


class HelperError(Exception):
    """A refusal. The message names a rule, never file contents."""

    def __init__(self, message, code=CODE_TRANSPORT):
        super().__init__(message)
        self.code = code if code in CODES else CODE_TRANSPORT


class NotRegular(Exception):
    """The final component exists but is not a regular file."""

    def __init__(self, message, code=CODE_NOT_FOUND):
        super().__init__(message)
        self.code = code


def code_for_errno(number):
    """The taxonomy code for one errno, so absences and refusals stay apart."""
    if number == errno.ENOENT:
        return CODE_NOT_FOUND
    if number == errno.ENOTDIR:
        return CODE_NOT_DIRECTORY
    if number in (errno.ELOOP, errno.EMLINK, errno.EACCES, errno.EPERM):
        return CODE_UNSAFE_PATH
    if number in (errno.ENAMETOOLONG, errno.EINVAL):
        return CODE_UNSAFE_PATH
    return CODE_TRANSPORT


def describe_errno(code):
    """One short phrase per code, so a caller can match on text if it must."""
    return {
        CODE_NOT_FOUND: "no such file or directory",
        CODE_NOT_DIRECTORY: "path is not a directory",
        CODE_UNSAFE_PATH: "path is not permitted",
        CODE_LIMIT_EXCEEDED: "artifact exceeds a configured limit",
        CODE_SOURCE_CHANGED: "source changed during capture",
        CODE_TRANSPORT: "artifact transport failed",
    }[code]


def require_int(value, name, minimum=0, maximum=(1 << 62)):
    if isinstance(value, bool) or not isinstance(value, int):
        raise HelperError("%s must be an integer" % name, CODE_UNSAFE_PATH)
    if value < minimum or value > maximum:
        raise HelperError("%s is out of range" % name, CODE_LIMIT_EXCEEDED)
    return value


def field(request, name):
    if name not in request:
        raise HelperError("%s is required" % name, CODE_UNSAFE_PATH)
    return request[name]


def archive_name_ok(name):
    """A discovered directory entry that may be named in an archive.

    Anything that is not a plain, bounded, traversal-free name is skipped rather
    than archived, so the member name in the archive always describes the path it
    was read from and never turns into `..` or a control character.
    """
    if not name or len(name) > 255 or len(name.encode("utf-8", "surrogateescape")) > MAX_ARCNAME:
        return False
    if name in (".", "..") or "/" in name or "\\" in name:
        return False
    if any(ord(ch) < 32 or ord(ch) == 127 for ch in name):
        return False
    return True


def require_name(value):
    if not isinstance(value, str) or not NAME_RE.match(value):
        raise HelperError("staged file name is invalid", CODE_UNSAFE_PATH)
    return value


def clean_relative(path, allow_empty=False):
    """A workspace-relative path, validated as strictly as a requested name."""
    if not isinstance(path, str):
        raise HelperError("path must be a string", CODE_UNSAFE_PATH)
    if len(path.encode("utf-8", "surrogateescape")) > 1024:
        raise HelperError("path exceeds 1024 bytes", CODE_UNSAFE_PATH)
    if path.startswith("/") or "\\" in path or "\x00" in path:
        raise HelperError(
            "path must be a relative workspace path", CODE_UNSAFE_PATH
        )
    parts = [part for part in path.split("/") if part]
    if not parts and not allow_empty:
        raise HelperError("path must not be empty", CODE_UNSAFE_PATH)
    if len(parts) > 32:
        raise HelperError("path has more than 32 components", CODE_UNSAFE_PATH)
    for part in parts:
        if part in (".", ".."):
            raise HelperError(
                "path must not traverse directories", CODE_UNSAFE_PATH
            )
        if any(ord(ch) < 32 or ord(ch) == 127 for ch in part):
            raise HelperError(
                "path contains a control character", CODE_UNSAFE_PATH
            )
    return parts


def clean_absolute(path):
    """Validated absolute components of a path, with no traversal."""
    if not isinstance(path, str) or not path.startswith("/"):
        raise HelperError("root must be an absolute path", CODE_UNSAFE_PATH)
    if len(path.encode("utf-8", "surrogateescape")) > 4096:
        raise HelperError("root is too long", CODE_UNSAFE_PATH)
    if "\\" in path or "\x00" in path:
        raise HelperError("root contains an invalid character", CODE_UNSAFE_PATH)
    parts = [part for part in path.split("/") if part and part != "."]
    for part in parts:
        if part == ".." or any(ord(ch) < 32 or ord(ch) == 127 for ch in part):
            raise HelperError(
                "root must not traverse directories", CODE_UNSAFE_PATH
            )
    return parts


def root_path(root):
    parts = clean_absolute(root)
    if not parts:
        # The whole filesystem is never a permitted capture root: it is not
        # private, and a capture scoped to it would walk everything a worker can
        # reach rather than one workspace.
        raise HelperError(
            "root must be a directory inside the guest, not the filesystem root",
            CODE_UNSAFE_PATH,
        )
    return "/" + "/".join(parts)


def step_refusal(parent_fd, name, error):
    """Classify one refused step, telling a symlink apart from a wrong type.

    The kernel reports a symlink opened with O_NOFOLLOW|O_DIRECTORY as
    `ENOTDIR`, exactly as it reports a plain file, so the pinned parent is the
    only place the two can be told apart. The difference matters: a symlink is a
    refusal to read, and must never be reported as a type mismatch that a caller
    could treat as a harmless absence.
    """
    code = code_for_errno(error.errno)
    if code == CODE_NOT_DIRECTORY:
        try:
            info = os.lstat(name, dir_fd=parent_fd)
        except OSError:
            return CODE_NOT_FOUND, "no such file or directory"
        if statmod.S_ISLNK(info.st_mode):
            return CODE_UNSAFE_PATH, "path component is a symlink"
        return CODE_NOT_DIRECTORY, "path is not a directory"
    if code == CODE_NOT_FOUND:
        return CODE_NOT_FOUND, "no such file or directory"
    if code == CODE_UNSAFE_PATH:
        if error.errno == errno.ELOOP:
            return CODE_UNSAFE_PATH, "path component is a symlink"
        return CODE_UNSAFE_PATH, "path is not permitted"
    return code, "artifact capture failed: %s" % errno_name(error)


def open_at(parts, want_directory=True):
    """Open `parts` with every component pinned from the filesystem root.

    Pinning starts at `/` and takes one descriptor-relative step at a time, so a
    symlink anywhere along the path - not only at the last component - is refused
    instead of followed, and there is no check-then-use window: each step is
    resolved against the descriptor the previous step returned.
    """
    fd = os.open("/", DIR_FLAGS)
    try:
        for name in parts:
            try:
                nxt = os.open(name, DIR_FLAGS, dir_fd=fd)
            except OSError as error:
                code, reason = step_refusal(fd, name, error)
                raise HelperError(reason, code)
            if not statmod.S_ISDIR(os.fstat(nxt).st_mode):
                os.close(nxt)
                raise HelperError("path is not a directory", CODE_NOT_DIRECTORY)
            os.close(fd)
            fd = nxt
    except BaseException:
        os.close(fd)
        raise
    return fd


def open_dir_at(root, parts):
    """Open the permitted root and walk down to `parts` inside it."""
    fd = open_at(clean_absolute(root))
    try:
        for name in parts:
            try:
                nxt = os.open(name, DIR_FLAGS, dir_fd=fd)
            except OSError as error:
                code, reason = step_refusal(fd, name, error)
                raise HelperError(reason, code)
            if not statmod.S_ISDIR(os.fstat(nxt).st_mode):
                os.close(nxt)
                raise HelperError("path is not a directory", CODE_NOT_DIRECTORY)
            os.close(fd)
            fd = nxt
    except BaseException:
        os.close(fd)
        raise
    return fd


def open_regular_at(root, parts):
    """Open one regular file with every parent pinned and no symlink followed."""
    parent = open_dir_at(root, parts[:-1])
    try:
        try:
            fd = os.open(parts[-1], FILE_FLAGS, dir_fd=parent)
        except OSError as error:
            code, reason = step_refusal(parent, parts[-1], error)
            if code == CODE_NOT_DIRECTORY:
                raise NotRegular("artifact is not a directory", code)
            raise NotRegular(reason, code)
    finally:
        os.close(parent)
    if not statmod.S_ISREG(os.fstat(fd).st_mode):
        os.close(fd)
        raise NotRegular("artifact is not a regular file", CODE_NOT_DIRECTORY)
    return fd


def lstat_at(root, parts):
    parent = open_dir_at(root, parts[:-1])
    try:
        try:
            return os.lstat(parts[-1], dir_fd=parent)
        except OSError as error:
            raise NotRegular("artifact is missing", code_for_errno(error.errno))
    finally:
        os.close(parent)


def open_staging(staging):
    """Pin the private staging directory, component by component, from `/`."""
    if not isinstance(staging, str) or not staging.startswith("/"):
        raise HelperError("staging must be an absolute path", CODE_UNSAFE_PATH)
    if "\x00" in staging or "\\" in staging:
        raise HelperError("staging contains an invalid character", CODE_UNSAFE_PATH)
    try:
        fd = open_at(clean_absolute(staging))
    except HelperError as error:
        raise HelperError("staging directory is not accessible", error.code)
    # Staged bytes are the only copy of the artifact in the guest: they must not
    # be reachable by the worker's own user or by anyone else on the guest.
    if statmod.S_IMODE(os.fstat(fd).st_mode) & 0o077:
        os.close(fd)
        raise HelperError("staging directory is not private", CODE_UNSAFE_PATH)
    return fd


def scandir_bounded(fd, budget):
    """At most `budget` names, without materialising or sorting a whole directory.

    `os.listdir` on a directory with a million entries allocates a million
    strings before the first entry can be refused, and a worker controls what is
    in its workspace. The budget is the bound, and a full walk stops there.
    """
    names = []
    overflow = False
    with os.scandir(fd) as entries:
        for entry in entries:
            if len(names) >= budget:
                overflow = True
                break
            names.append(entry.name)
    return names, overflow


def staged_fd(staging_fd, name):
    require_name(name)
    return os.open(name, WRITE_FLAGS, 0o600, dir_fd=staging_fd)


def discard(staging_fd, name):
    try:
        os.unlink(name, dir_fd=staging_fd)
    except OSError:
        pass


def write_all(fd, data):
    view = memoryview(data)
    sent = 0
    while sent < len(view):
        sent += os.write(fd, view[sent:])


def hash_fd(fd):
    digest = hashlib.sha256()
    total = 0
    while True:
        chunk = os.read(fd, CHUNK)
        if not chunk:
            break
        total += len(chunk)
        digest.update(chunk)
    os.lseek(fd, 0, os.SEEK_SET)
    return total, digest.hexdigest()


def copy_bounded(src_fd, dst_fd, max_bytes, limit=None):
    """Copy a regular file into staging while hashing it, refusing to exceed the bound."""
    digest = hashlib.sha256()
    total = 0
    cap = max_bytes if limit is None else min(max_bytes, limit)
    while True:
        # Never read past the bound: a windowed capture copies the window only.
        chunk = os.read(src_fd, min(CHUNK, cap - total))
        if not chunk:
            break
        total += len(chunk)
        digest.update(chunk)
        write_all(dst_fd, chunk)
    return total, digest.hexdigest()


def require_unchanged(fd, before, root, parts):
    """Fail closed unless the source is still the same regular file it was.

    The copy itself is consistent because it reads one pinned descriptor; this
    catches an in-place rewrite and a path replaced with different content
    while the copy ran, either of which would make the staged bytes a mixture
    that never existed on disk.
    """
    after = os.fstat(fd)
    if (
        (after.st_dev, after.st_ino) != (before.st_dev, before.st_ino)
        or after.st_size != before.st_size
        or after.st_mtime_ns != before.st_mtime_ns
    ):
        raise HelperError("source changed during capture", CODE_SOURCE_CHANGED)
    try:
        again = open_regular_at(root, parts)
    except NotRegular:
        raise HelperError("source changed during capture", CODE_SOURCE_CHANGED)
    try:
        current = os.fstat(again)
        if (current.st_dev, current.st_ino) != (before.st_dev, before.st_ino):
            raise HelperError(
                "source changed during capture", CODE_SOURCE_CHANGED
            )
    finally:
        os.close(again)


class FdWriter:
    """Minimal writable file object over a staging descriptor."""

    def __init__(self, fd):
        self.fd = fd
        self.size = 0

    def write(self, data):
        write_all(self.fd, data)
        self.size += len(data)
        return len(data)

    def flush(self):
        pass

    def tell(self):
        return self.size


class FdReader:
    """Minimal readable file object over a pinned descriptor, bounded in size."""

    def __init__(self, fd, remaining):
        self.fd = fd
        self.remaining = remaining

    def read(self, size=-1):
        if self.remaining <= 0:
            return b""
        want = self.remaining if size is None or size < 0 else min(size, self.remaining)
        chunk = os.read(self.fd, want)
        self.remaining -= len(chunk)
        return chunk


def op_open(request):
    root = root_path(field(request, "root"))
    parts = clean_relative(field(request, "path"))
    max_bytes = require_int(field(request, "max_bytes"), "max_bytes", 1)
    offset = require_int(request.get("offset", 0), "offset", 0)
    length = request.get("length")
    if length is not None:
        length = require_int(length, "length", 0)
    name = field(request, "name")
    staging_fd = open_staging(field(request, "staging"))
    try:
        try:
            fd = open_regular_at(root, parts)
        except NotRegular as error:
            raise HelperError(str(error), getattr(error, "code", CODE_NOT_FOUND))
        try:
            before = os.fstat(fd)
            total = before.st_size
            if offset > total:
                raise HelperError(
                    "offset is past the end of the artifact", CODE_UNSAFE_PATH
                )
            window = total - offset
            if length is not None:
                window = min(window, length)
            if window > max_bytes:
                raise HelperError(
                    "artifact exceeds the configured maximum size",
                    CODE_LIMIT_EXCEEDED,
                )
            os.lseek(fd, offset, os.SEEK_SET)
            out_fd = staged_fd(staging_fd, name)
            try:
                size, digest = copy_bounded(fd, out_fd, max_bytes, window)
                os.fsync(out_fd)
            except BaseException:
                os.close(out_fd)
                discard(staging_fd, name)
                raise
            os.close(out_fd)
            require_unchanged(fd, before, root, parts)
            return {
                "op": "open",
                "name": name,
                "filename": parts[-1],
                "size": size,
                "sha256": digest,
                "total_size": total,
            }
        finally:
            os.close(fd)
    finally:
        os.close(staging_fd)


def op_list(request):
    root = root_path(field(request, "root"))
    parts = clean_relative(request.get("path", ""), allow_empty=True)
    max_entries = require_int(request.get("max_entries", 1000), "max_entries", 1)
    max_depth = require_int(request.get("max_depth", 32), "max_depth", 1)
    if len(parts) > max_depth:
        raise HelperError(
            "path is deeper than the configured maximum depth",
            CODE_LIMIT_EXCEEDED,
        )
    offset = require_int(request.get("offset", 0), "offset", 0)
    limit = require_int(request.get("limit", 100), "limit", 1)
    # One more than the budget is enough to know the budget was reached, and the
    # walk stops there: a worker cannot make this allocate its way through a
    # directory it controls.
    dir_fd = open_dir_at(root, parts)
    try:
        names, overflow = scandir_bounded(dir_fd, max_entries + 1)
        truncated = overflow or len(names) > max_entries
        names = sorted(names)[:max_entries]
        entries = []
        for name in names:
            try:
                info = os.lstat(name, dir_fd=dir_fd)
            except OSError:
                # Vanished between the listing and the stat: nothing to describe.
                continue
            mode = info.st_mode
            if statmod.S_ISLNK(mode):
                kind = "symlink"
            elif statmod.S_ISDIR(mode):
                kind = "directory"
            elif statmod.S_ISREG(mode):
                kind = "file"
            else:
                kind = "other"
            entry = {"name": name, "kind": kind}
            if kind == "file":
                entry["size"] = info.st_size
            entries.append(entry)
    finally:
        os.close(dir_fd)
    page = entries[offset : offset + limit]
    following = offset + len(page)
    return {
        "op": "list",
        "entries": page,
        "next_offset": following if following < len(entries) else None,
        "total": len(entries),
        "truncated": truncated,
    }


def add_file(tar, root, parts, arcname, state, max_bytes):
    fd = open_regular_at(root, parts)
    try:
        info = os.fstat(fd)
        if info.st_size + state["source"] > max_bytes:
            raise HelperError(
                "snapshot source exceeds the configured maximum byte limit",
                CODE_LIMIT_EXCEEDED,
            )
        entry = tarfile.TarInfo(arcname)
        entry.type = tarfile.REGTYPE
        entry.size = info.st_size
        entry.mode = 0o644
        entry.mtime = int(info.st_mtime)
        entry.uid = 0
        entry.gid = 0
        entry.uname = ""
        entry.gname = ""
        tar.addfile(entry, FdReader(fd, info.st_size))
        state["source"] += info.st_size
        state["entries"] += 1
        if state["source"] > max_bytes or state["writer"].size > max_bytes:
            raise HelperError(
                "snapshot exceeds the configured maximum size",
                CODE_LIMIT_EXCEEDED,
            )
    finally:
        os.close(fd)


def add_directory(tar, root, parts, arcname, state, max_bytes, max_entries, max_depth, strict):
    if parts:
        try:
            info = lstat_at(root, parts)
        except NotRegular:
            if strict:
                raise HelperError(
                    "no such file or directory: snapshot source is missing",
                    CODE_NOT_FOUND,
                )
            return
        mode = info.st_mode
        if statmod.S_ISREG(mode):
            if state["entries"] >= max_entries:
                state["truncated"] = True
                return
            add_file(tar, root, parts, arcname, state, max_bytes)
            return
        # Symlinks, FIFOs, sockets and devices are never captured, and a caller
        # that named one explicitly is told so rather than given a surprise.
        if not statmod.S_ISDIR(mode):
            if strict:
                raise HelperError(
                    "snapshot source is not a regular file or directory",
                    CODE_NOT_DIRECTORY,
                )
            return
    if parts:
        if state["entries"] >= max_entries:
            state["truncated"] = True
            return
        entry = tarfile.TarInfo(arcname)
        entry.type = tarfile.DIRTYPE
        entry.mode = 0o755
        entry.mtime = int(info.st_mtime)
        entry.uid = 0
        entry.gid = 0
        entry.uname = ""
        entry.gname = ""
        tar.addfile(entry)
        state["entries"] += 1
    if len(parts) >= max_depth:
        state["truncated"] = True
        return
    dir_fd = open_dir_at(root, parts)
    try:
        # The entry budget is spent by this walk, not only by what it archives,
        # so a huge tree stops at the cap instead of being walked whole.
        room = max_entries + 1 - state["entries"]
        if room <= 0:
            state["truncated"] = True
            return
        names, overflow = scandir_bounded(dir_fd, room)
        if overflow:
            state["truncated"] = True
        for name in sorted(names):
            if name in EXCLUDED:
                continue
            # A discovered name is validated like a requested path: no traversal,
            # no control characters, and nothing that would make the archive
            # member name disagree with the path it came from.
            if not archive_name_ok(name):
                state["skipped"] = True
                continue
            try:
                child_info = os.lstat(name, dir_fd=dir_fd)
            except OSError:
                continue
            child_mode = child_info.st_mode
            if statmod.S_ISLNK(child_mode):
                # Never followed, never archived: a symlink is not content.
                continue
            if not (
                statmod.S_ISREG(child_mode) or statmod.S_ISDIR(child_mode)
            ):
                continue
            child = parts + [name]
            if len(child) > max_depth:
                state["truncated"] = True
                continue
            child_arc = name if arcname == "." else arcname + "/" + name
            if len(child_arc.encode("utf-8", "surrogateescape")) > MAX_ARCNAME:
                state["skipped"] = True
                continue
            add_directory(
                tar,
                root,
                child,
                child_arc,
                state,
                max_bytes,
                max_entries,
                max_depth,
                False,
            )
    finally:
        os.close(dir_fd)


def op_snapshot(request):
    root = root_path(field(request, "root"))
    max_bytes = require_int(field(request, "max_bytes"), "max_bytes", 1)
    max_entries = require_int(field(request, "max_entries"), "max_entries", 1)
    max_depth = require_int(field(request, "max_depth"), "max_depth", 1)
    raw_paths = request.get("paths") or []
    if not isinstance(raw_paths, list) or len(raw_paths) > max_entries:
        raise HelperError("paths is invalid", CODE_UNSAFE_PATH)
    selected = [clean_relative(item) for item in raw_paths]
    for parts in selected:
        if len(parts) > max_depth:
            raise HelperError(
                "path is deeper than the configured maximum depth",
                CODE_LIMIT_EXCEEDED,
            )
    name = field(request, "name")
    staging_fd = open_staging(field(request, "staging"))
    try:
        out_fd = staged_fd(staging_fd, name)
        try:
            writer = FdWriter(out_fd)
            state = {
                "source": 0,
                "entries": 0,
                "truncated": False,
                "writer": writer,
            }
            with gzip.GzipFile(fileobj=writer, mode="wb", mtime=0) as gz:
                with tarfile.open(fileobj=gz, mode="w", format=tarfile.GNU_FORMAT) as tar:
                    if selected:
                        for parts in selected:
                            add_directory(
                                tar,
                                root,
                                parts,
                                "/".join(parts),
                                state,
                                max_bytes,
                                max_entries,
                                max_depth,
                                True,
                            )
                    else:
                        add_directory(
                            tar,
                            root,
                            [],
                            ".",
                            state,
                            max_bytes,
                            max_entries,
                            max_depth,
                            True,
                        )
                    if writer.size > max_bytes:
                        raise HelperError(
                "snapshot exceeds the configured maximum size",
                CODE_LIMIT_EXCEEDED,
            )
            os.fsync(out_fd)
        except BaseException:
            os.close(out_fd)
            discard(staging_fd, name)
            raise
        os.close(out_fd)
        staged = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=staging_fd)
        try:
            if os.fstat(staged).st_size > max_bytes:
                raise HelperError(
                "snapshot exceeds the configured maximum size",
                CODE_LIMIT_EXCEEDED,
            )
            size, digest = hash_fd(staged)
        finally:
            os.close(staged)
        return {
            "op": "snapshot",
            "name": name,
            "filename": "snapshot.tar.gz",
            "size": size,
            "sha256": digest,
            "entries": state["entries"],
            "truncated": state["truncated"],
            "source_bytes": state["source"],
        }
    finally:
        os.close(staging_fd)


def run_bounded(argv, dst_fd, budget, digest, stats, root, cwd, deadline):
    """Copy a command's stdout into the staged file, strictly inside `budget`."""
    if budget <= 0:
        stats["truncated"] = True
        return 0
    try:
        proc = subprocess.Popen(
            argv,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            # A command's own diagnostics are evidence, so they are read - but
            # they never reach this program's stdout, and they are bounded both
            # by the capture budget and by STDERR_BOUND.
            stderr=subprocess.PIPE,
            cwd=cwd,
            env=CHILD_ENV,
            start_new_session=True,
        )
    except OSError:
        stats["failed"] += 1
        return 0
    total = 0
    errors = b""
    try:
        while True:
            remaining = deadline - _now()
            if remaining <= 0:
                stats["timed_out"] = True
                break
            ready, _, _ = select.select(
                [proc.stdout, proc.stderr], [], [], min(remaining, 0.25)
            )
            if proc.stderr in ready and len(errors) < STDERR_BOUND:
                errors += proc.stderr.read1(STDERR_BOUND - len(errors))
            if proc.stdout in ready:
                chunk = proc.stdout.read1(CHUNK)
                if not chunk:
                    break
                room = budget - total
                if len(chunk) > room:
                    chunk = chunk[:room]
                    stats["truncated"] = True
                if chunk:
                    write_all(dst_fd, chunk)
                    digest.update(chunk)
                    total += len(chunk)
                if total >= budget:
                    stats["truncated"] = True
                    break
                continue
            if not ready:
                if proc.poll() is not None and proc.stdout.readable():
                    # The child is done and the pipe is at end of file.
                    if len(errors) < STDERR_BOUND:
                        try:
                            errors += proc.stderr.read1(STDERR_BOUND - len(errors))
                        except OSError:
                            pass
                    break
    finally:
        for pipe in (proc.stdout, proc.stderr):
            try:
                pipe.close()
            except OSError:
                pass
        killed = False
        if proc.poll() is None:
            killed = True
            # The child writes to a pipe we stop reading; stop the child too.
            try:
                os.killpg(proc.pid, 9)
            except OSError:
                proc.kill()
        exit_code = proc.wait()
        if exit_code and not killed and not stats["timed_out"]:
            stats["failed"] += 1
        if len(errors) > STDERR_BOUND:
            stats["truncated"] = True
    stats["bytes"] += total
    return exit_code, errors


def _now():
    return time.monotonic()


def source_cwd(root, relative):
    """Resolve a source directory inside the permitted root, refusing symlinks.

    The command must run somewhere the requester could not have redirected out
    of the root: every component is opened descriptor-relatively with
    O_NOFOLLOW, so a directory that is really a symlink to somewhere else is
    reported instead of followed.
    """
    if not relative:
        return root
    parts = clean_relative(relative)
    fd = open_dir_at(root, parts)
    os.close(fd)
    return "/".join([root.rstrip("/")] + parts)


# A Git command is only run against a repository this helper has opened itself.
# Flags alone are not enough while a repository may name its own metadata
# elsewhere, so the metadata is verified first and the command is then pinned to
# the two paths that were verified.
GIT_PINNED = (
    "--no-pager",
    # Nothing in the repository's own configuration may turn a read into a
    # command, move the work tree, or name a remote: the capture runs against the
    # two paths this helper verified, and every knob that could aim it elsewhere
    # is pinned here as well.
    "-c", "core.bare=false",
    "-c", "core.logAllRefUpdates=false",
    "-c", "core.hooksPath=/dev/null",
    "-c", "core.fsmonitor=false",
    "-c", "core.alternateRefsCommand=",
    "-c", "core.attributesFile=/dev/null",
    "-c", "core.hooksPath=/dev/null",
    "-c", "diff.external=",
    "-c", "diff.renames=false",
    "-c", "diff.algorithm=myers",
    "-c", "diff.noprefix=false",
    "-c", "safe.directory=*",
)

# Bytes a source's own diagnostics may add to the private staged file.
STDERR_BOUND = 4096
ALTERNATES_BOUND = 64 * 1024
# The metadata tree Git will resolve is walked whole, inside these bounds. A
# repository that is bigger than this is not described rather than walked: the
# budget is the limit of what can be verified, and an unverified repository is not
# captured at all.
METADATA_MAX_ENTRIES = 20000
METADATA_MAX_DEPTH = 8
# An alternates chain is followed only inside the root and only this deep.
ALTERNATES_MAX_DEPTH = 4
ALTERNATES_MAX_STORES = 64


class GitRefusal(Exception):
    """A repository this helper will not describe, and why."""


class GitResource(Exception):
    """The check could not be completed: descriptors, memory, permissions, a
    signal or a bad handle.

    This is deliberately not a GitRefusal. A refusal is a statement about the
    repository - it points somewhere the root does not allow - and it is reported
    as not applicable. A resource error says nothing about the repository: it says
    this process could not look, so the capture is incomplete and must be reported
    as such rather than quietly skipped.
    """


# Errno values that mean "this process could not do it", never "that path is not
# allowed".
RESOURCE_ERRNOS = (
    errno.EMFILE,
    errno.ENFILE,
    errno.ENOMEM,
    errno.EACCES,
    errno.EPERM,
    errno.EINTR,
    errno.EBADF,
    errno.ENOTTY,
)


def metadata_refusal(error, what="Git metadata is not inside the permitted root"):
    """Turn a failed open into a refusal or a resource error, never a guess.

    A refusal is a statement about the repository. An errno that means this
    process could not look - descriptors, memory, permissions, a signal, a bad
    handle - is not, and must not be reported as one.
    """
    if getattr(error, "code", CODE_TRANSPORT) == CODE_TRANSPORT:
        raise GitResource("%s: %s" % (what, str(error) or "unusable"))
    raise GitRefusal(what)


def resource_or_refusal(error):
    """Classify one OSError: could not look, versus must not look."""
    if error.errno in RESOURCE_ERRNOS:
        raise GitResource("Git metadata could not be examined: %s" % errno_name(error))
    raise GitRefusal(
        "Git metadata is not inside the permitted root (%s)" % errno_name(error)
    )


def _read_bounded_fd(fd, limit):
    """Read at most `limit` bytes from a pinned descriptor."""
    out = b""
    while len(out) < limit:
        chunk = os.read(fd, min(CHUNK, limit - len(out)))
        if not chunk:
            break
        out += chunk
    return out


def _normalize(parts):
    """Resolve `.` and `..` lexically, refusing to climb above the start."""
    out = []
    for part in parts:
        if part in ("", "."):
            continue
        if part == "..":
            if not out:
                raise GitRefusal("alternates entry escapes the permitted root")
            out.pop()
            continue
        out.append(part)
    return out


def _under_root(root_parts, parts):
    """True when `parts` is the root or sits under it, compared by component.

    A string prefix would accept a sibling whose name merely starts with the
    root's, so the comparison is component by component.
    """
    return parts[: len(root_parts)] == root_parts and len(parts) >= len(root_parts)


def _resolve_alternate(root, base, line):
    """Resolve one alternates entry and require it to stay inside the root.

    A relative entry is resolved against the object directory it was named in; an
    absolute one is taken as it stands. Either way the result has to be a real
    directory inside the permitted root, reached the same pinned way as any other
    path, so an alternates file cannot borrow objects from anywhere else.
    """
    line = line.strip()
    if not line or line.startswith("#"):
        return
    if "\x00" in line:
        raise GitRefusal("alternates entry is not a usable path")
    root_parts = clean_absolute(root)
    if line.startswith("/"):
        parts = _normalize(clean_absolute(line))
    else:
        # A relative entry is resolved against the object directory it was named
        # in, and may legitimately step out of it as long as it stays inside the
        # permitted root.
        parts = _normalize(base + line.split("/"))
    if not _under_root(root_parts, parts):
        raise GitRefusal("alternates points outside the permitted root")
    fd = open_at(parts)
    os.close(fd)


def _walk_metadata(parts, depth=0):
    """Every entry under a metadata directory, inside a hard budget.

    Git resolves paths inside its own metadata as it reads it, so the only way to
    know that none of them is a symlink out of the permitted root is to look at
    all of them. Anything that is not a plain file or directory - a symlink, a
    FIFO, a device, a socket - refuses the repository, and so does a tree that
    does not fit the budget, because an unverified repository is not described.

    Descriptors are owned explicitly and released on every path, including an
    error: one descriptor is held per level and released on every path, including
    an error. A walk that leaked one descriptor per directory would run out of them
    on a repository with a few hundred directories, and would report that as a
    statement about the repository, which it is not.
    """
    if depth > METADATA_MAX_DEPTH:
        raise GitRefusal("Git metadata is deeper than its bound")
    try:
        fd = open_at(parts)
    except HelperError as error:
        metadata_refusal(error)
    # The descriptor stays open for the whole iteration - closing it first breaks
    # the iterator - and is closed here exactly once, on every path, after the
    # iterator has been closed. os.scandir may or may not duplicate what it is
    # handed, and it offers no way to ask, so this owns one descriptor per level
    # itself rather than guessing who owns it. That is what keeps a walk of a few
    # hundred directories from running out of them.
    entries = None
    try:
        # One entry at a time, so a directory with a million entries costs one unit
        # of budget rather than a million strings.
        try:
            entries = os.scandir(fd)
        except OSError as error:
            resource_or_refusal(error)
            raise
        seen = 0
        with entries:
            for entry in entries:
                seen += 1
                if seen > METADATA_MAX_ENTRIES:
                    raise GitRefusal("Git metadata exceeds its entry bound")
                try:
                    info = entry.stat(follow_symlinks=False)
                except OSError as error:
                    resource_or_refusal(error)
                    raise
                if statmod.S_ISLNK(info.st_mode):
                    raise GitRefusal("Git metadata contains a symlink")
                if statmod.S_ISDIR(info.st_mode):
                    _walk_metadata(parts + [entry.name], depth + 1)
                    continue
                if not statmod.S_ISREG(info.st_mode):
                    raise GitRefusal("Git metadata contains a special file")
    except OSError as error:
        # The directory iterator itself failing part way through is a read error,
        # not a statement about the tree.
        resource_or_refusal(error)
        raise
    finally:
        if entries is not None:
            try:
                entries.close()
            except OSError:
                pass
        try:
            os.close(fd)
        except OSError:
            pass


def _read_pinned(parent_fd, name, bound):
    """One bounded, descriptor-relative read. The handle is always released."""
    try:
        info = os.lstat(name, dir_fd=parent_fd)
    except OSError as error:
        if error.errno in RESOURCE_ERRNOS:
            resource_or_refusal(error)
        return None
    if not statmod.S_ISREG(info.st_mode):
        raise GitRefusal("Git object alternates is not a regular file")
    if info.st_size > bound:
        raise GitRefusal("Git object alternates is larger than its bound")
    try:
        handle = os.open(
            name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent_fd
        )
    except OSError as error:
        resource_or_refusal(error)
        raise
    try:
        return _read_bounded_fd(handle, bound)
    finally:
        os.close(handle)


def _check_alternates(root, root_parts, objects_parts, depth=0, seen=None):
    """Follow an alternates chain, refusing anything outside the permitted root.

    A store may name stores of its own, so this recurses: every level is resolved
    inside the root, and both the depth and the number of stores are bounded, so
    a chain that loops or fans out is refused rather than followed.
    """
    if depth > ALTERNATES_MAX_DEPTH:
        raise GitRefusal("Git object alternates chain is too deep")
    visited = set() if seen is None else seen
    key = "/".join(objects_parts)
    if key in visited:
        raise GitRefusal("Git object alternates chain repeats a store")
    visited.add(key)
    if len(visited) > ALTERNATES_MAX_STORES:
        raise GitRefusal("Git object alternates chain names too many stores")
    try:
        info_fd = open_at(objects_parts + ["info"])
    except HelperError as error:
        if getattr(error, "code", CODE_TRANSPORT) == CODE_TRANSPORT:
            raise GitResource("Git object alternates could not be read")
        return
    try:
        for name in ("alternates", "http-alternates"):
            body = _read_pinned(info_fd, name, ALTERNATES_BOUND)
            if body is None:
                continue
            if name == "http-alternates" and body.strip():
                raise GitRefusal("Git object alternates names a remote store")
            for line in body.decode("utf-8", "replace").splitlines():
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                if "\x00" in line:
                    raise GitRefusal("alternates entry is not a usable path")
                if line.startswith("/"):
                    parts = _normalize(clean_absolute(line))
                else:
                    parts = _normalize(objects_parts + line.split("/"))
                if not _under_root(root_parts, parts):
                    raise GitRefusal(
                        "alternates points outside the permitted root"
                    )
                store = open_at(parts)
                os.close(store)
                _check_alternates(root, root_parts, parts, depth + 1, visited)
    finally:
        os.close(info_fd)


def _commondir_parts(root_parts, git_parts):
    """The shared metadata directory Git would use, verified inside the root.

    A `commondir` file is how a linked worktree names metadata that lives
    elsewhere. Git follows it, so it is resolved and checked like any other path
    before a command runs; one that leaves the permitted root refuses the capture.
    """
    try:
        fd = open_at(root_parts + git_parts)
    except HelperError as error:
        metadata_refusal(error, "Git metadata directory is not accessible")
    # Released below in every path, including a refusal raised while reading.
    try:
        body = _read_pinned(fd, "commondir", 4096)
    finally:
        os.close(fd)
    if body is None:
        return None
    text = body.decode("utf-8", "replace").strip()
    if not text or "\x00" in text:
        raise GitRefusal("Git metadata commondir is not a usable path")
    if text.startswith("/"):
        parts = _normalize(clean_absolute(text))
    else:
        parts = _normalize(git_parts + text.split("/"))
    if not _under_root(root_parts, parts):
        raise GitRefusal("Git metadata commondir points outside the permitted root")
    store = open_at(parts)
    os.close(store)
    return parts


def git_repository(root, relative):
    """Verify a repository and return the two pinned paths to run Git against.

    Everything is opened descriptor-relatively from `/`, so a component that is a
    symlink is refused rather than followed. A `gitdir:` pointer file is refused
    outright: it is the one shape whose whole purpose is to name metadata
    elsewhere, and no flag can make a repository whose metadata is outside the
    root safe to describe. What Git resolves for itself is then checked too - the
    whole metadata tree entry by entry, a shared metadata directory named by
    `commondir`, and an alternates chain followed recursively - and anything that
    cannot be verified disables the capture rather than being trusted.
    """
    base = relative.split("/") if relative else []
    root_parts = clean_absolute(root)
    try:
        work_tree_fd = open_dir_at(root, base)
    except HelperError as error:
        metadata_refusal(error, "no such directory in the workspace")
    os.close(work_tree_fd)
    try:
        parent = open_dir_at(root, base)
    except HelperError as error:
        metadata_refusal(error, "no such directory in the workspace")
    try:
        try:
            info = os.lstat(".git", dir_fd=parent)
        except OSError:
            raise GitRefusal("no Git metadata in the workspace")
        if statmod.S_ISLNK(info.st_mode):
            raise GitRefusal("Git metadata is a symlink")
        if not statmod.S_ISDIR(info.st_mode):
            # A `gitdir:` pointer file, a regular file, or anything else that is
            # not a real metadata directory.
            raise GitRefusal("Git metadata is not a directory")
    finally:
        os.close(parent)
    git_parts = base + [".git"]
    # Both paths are built from the components that were just opened, so the
    # command line names the same two directories this helper verified.
    git_dir = "/" + "/".join(root_parts + git_parts)
    work_tree = "/" + "/".join(root_parts + base)
    for name in ("objects", "refs"):
        try:
            fd = open_at(root_parts + git_parts + [name])
        except HelperError as error:
            # A metadata directory without an object store or a ref store is not
            # a repository this capture can describe. Disabling the Git sources is
            # the answer; failing the whole diagnostic would not be. An errno that
            # means this process could not look is neither.
            metadata_refusal(
                error, "Git metadata is missing its %s directory" % name
            )
        os.close(fd)
    shared = _commondir_parts(root_parts, git_parts)
    # The whole metadata tree, in both the repository's own directory and a shared
    # one it names, entry by entry and inside the budget.
    _walk_metadata(root_parts + git_parts)
    if shared is not None:
        _walk_metadata(shared)
    _check_alternates(root, root_parts, root_parts + git_parts + ["objects"])
    if shared is not None:
        _check_alternates(root, root_parts, shared + ["objects"])
    return git_dir, work_tree


def git_argv(git_dir, work_tree, args):
    """A Git command pinned to the two verified paths, with no ambient config."""
    argv = ["git"]
    for item in GIT_PINNED:
        argv.append(item)
    argv.append("--git-dir")
    argv.append(git_dir)
    argv.append("--work-tree")
    argv.append(work_tree)
    # No `--` separator: Git takes its subcommand first, and the arguments that
    # follow were validated as plain bounded strings with no NUL.
    argv.extend(args)
    return argv


ANNOTATION = b"# swarmforge-capture "


def annotate(dst_fd, digest, stats, label, text, budget, stderr=b""):
    """Record what happened to one source inside the captured bytes."""
    parts = [ANNOTATION + text.encode("ascii", "replace") + b"\n"]
    if stderr:
        # The reason a command failed is part of the salvage evidence. It is
        # written into the private staged file - never into this program's stdout
        # - is bounded, and is marked as cut when the bound cut it.
        body = stderr[:STDERR_BOUND]
        if len(stderr) > STDERR_BOUND:
            stats["truncated"] = True
        for line in body.split(b"\n"):
            if not line.strip():
                continue
            parts.append(
                ANNOTATION
                + b"stderr "
                + line.replace(b"\r", b" ").decode("utf-8", "replace").encode(
                    "utf-8", "replace"
                )[:STDERR_BOUND]
                + b"\n"
            )
    for part in parts:
        if budget - stats["bytes"] < len(part):
            stats["truncated"] = True
            return
        write_all(dst_fd, part)
        digest.update(part)
        stats["bytes"] += len(part)


def op_capture(request):
    root = root_path(field(request, "root"))
    max_bytes = require_int(field(request, "max_bytes"), "max_bytes", 1)
    timeout = require_int(request.get("timeout_ms", 30000), "timeout_ms", 100, 600000)
    sources = request.get("sources")
    if not isinstance(sources, list) or not sources or len(sources) > MAX_SOURCES:
        raise HelperError(
            "sources is invalid", CODE_UNSAFE_PATH
        )
    parsed = []
    for source in sources:
        if not isinstance(source, dict):
            raise HelperError(
            "source is invalid", CODE_UNSAFE_PATH
        )
        is_git = bool(source.get("git"))
        argv = source.get("argv")
        if is_git:
            # A Git source never carries its own command line: this helper
            # supplies the executable and the repository, and the requester
            # supplies only the subcommand and its arguments.
            argv = []
        elif not isinstance(argv, list) or not argv or len(argv) > 64:
            raise HelperError(
            "source argv is invalid", CODE_UNSAFE_PATH
        )
        for argument in argv:
            if not isinstance(argument, str) or not argument or "\x00" in argument:
                raise HelperError(
            "source argv is invalid", CODE_UNSAFE_PATH
        )
            if len(argument) > 1024:
                raise HelperError(
            "source argv is invalid", CODE_UNSAFE_PATH
        )
        label = source.get("label")
        if label is not None and (
            not isinstance(label, str)
            or not label
            or len(label) > 64
            or any(ord(ch) < 32 or ord(ch) == 127 for ch in label)
        ):
            raise HelperError(
            "source label is invalid", CODE_UNSAFE_PATH
        )
        relative = source.get("cwd", "")
        if not isinstance(relative, str):
            raise HelperError(
            "source cwd is invalid", CODE_UNSAFE_PATH
        )
        if relative:
            clean_relative(relative)
        git_args = source.get("git_args") or []
        if is_git:
            if (
                not isinstance(git_args, list)
                or not git_args
                or len(git_args) > 32
                or any(
                    not isinstance(item, str)
                    or not item
                    or len(item) > 256
                    or "\x00" in item
                    for item in git_args
                )
            ):
                raise HelperError(
                    "source git_args is invalid", CODE_UNSAFE_PATH
                )
        parsed.append(
            {
                "argv": argv,
                "git_args": git_args,
                "label": label or "source",
                "cwd": relative,
                "git": is_git,
            }
        )
    name = field(request, "name")
    staging_fd = open_staging(field(request, "staging"))
    try:
        out_fd = staged_fd(staging_fd, name)
        digest = hashlib.sha256()
        stats = {
            "truncated": False,
            "timed_out": False,
            "failed": 0,
            "bytes": 0,
            "skipped": 0,
            "incomplete": 0,
        }
        reported = []
        try:
            deadline = _now() + timeout / 1000.0
            for source in parsed:
                label = source["label"]
                if _now() >= deadline:
                    # Out of time before this source even started: whatever the
                    # file holds is not the whole report, and it is recorded as
                    # such rather than being passed off as complete.
                    stats["timed_out"] = True
                    stats["incomplete"] += 1
                    annotate(
                        out_fd,
                        digest,
                        stats,
                        label,
                        "%s incomplete=not-started-before-deadline" % label,
                        max_bytes,
                    )
                    reported.append(
                        {"label": label, "incomplete": "not-started-before-deadline"}
                    )
                    break
                try:
                    cwd = source_cwd(root, source["cwd"])
                except HelperError as error:
                    if source["git"] and error.code == CODE_NOT_FOUND:
                        # A workspace that has no repository directory at all is a
                        # legitimate deployment, not a failure to retry for ever.
                        annotate(
                            out_fd,
                            digest,
                            stats,
                            label,
                            "%s not-applicable=no-repository-in-workspace" % label,
                            max_bytes,
                        )
                        reported.append(
                            {
                                "label": label,
                                "skipped": "not_applicable",
                                "reason": "no-repository-directory",
                            }
                        )
                        continue
                    # The directory is missing or is a symlink out of the root.
                    annotate(
                        out_fd,
                        digest,
                        stats,
                        label,
                        "%s skipped=directory-missing-or-outside-root" % label,
                        max_bytes,
                    )
                    reported.append(
                        {"label": label, "skipped": error.code}
                    )
                    stats["skipped"] += 1
                    continue
                if source["git"]:
                    # The repository is verified once per capture, by this helper,
                    # from descriptors it opened itself. A repository it cannot
                    # verify is recorded as not applicable: the capture is
                    # disabled rather than run against something unverified.
                    try:
                        git_dir, work_tree = git_repository(root, source["cwd"])
                    except GitResource as problem:
                        # This process could not examine the metadata. That says
                        # nothing about the repository, so the Git part of this
                        # capture is recorded as incomplete - never as skipped and
                        # never as a complete report - and the capture stops here
                        # rather than publishing a report with a hole in it.
                        stats["incomplete"] += 1
                        annotate(
                            out_fd,
                            digest,
                            stats,
                            label,
                            "%s incomplete=%s" % (label, problem),
                            max_bytes,
                        )
                        reported.append(
                            {
                                "label": label,
                                "incomplete": "metadata-unreadable",
                            }
                        )
                        break
                    except GitRefusal as refusal:
                        annotate(
                            out_fd,
                            digest,
                            stats,
                            label,
                            "%s not-applicable=%s" % (label, refusal),
                            max_bytes,
                        )
                        reported.append(
                            {
                                "label": label,
                                "skipped": "not_applicable",
                                "reason": str(refusal),
                            }
                        )
                        continue
                    command = git_argv(git_dir, work_tree, source["git_args"])
                else:
                    command = source["argv"]
                before = stats["bytes"]
                exit_code, errors = run_bounded(
                    command,
                    out_fd,
                    max_bytes - stats["bytes"],
                    digest,
                    stats,
                    root,
                    cwd,
                    deadline,
                )
                annotate(
                    out_fd,
                    digest,
                    stats,
                    label,
                    "%s exit=%d bytes=%d truncated=%s"
                    % (
                        label,
                        exit_code,
                        stats["bytes"] - before,
                        "yes" if stats["truncated"] else "no",
                    ),
                    max_bytes,
                    stderr=errors,
                )
                reported.append(
                    {
                        "label": label,
                        "exit": exit_code,
                        "bytes": stats["bytes"] - before,
                    }
                )
                if source["git"]:
                    # The worker owns everything under its workspace, so a
                    # repository verified before a command ran can be changed
                    # while it runs. The tree is checked again afterwards and the
                    # capture is refused if it no longer verifies. This narrows
                    # the window; it does not close it, because a hostile writer
                    # and a check cannot be made atomic from here, and nothing in
                    # this file claims otherwise.
                    try:
                        git_repository(root, source["cwd"])
                    except GitRefusal as refusal:
                        raise HelperError(
                            "Git metadata changed during the capture: %s" % refusal,
                            CODE_UNSAFE_PATH,
                        )
                if stats["timed_out"]:
                    # A source that had not finished when the deadline arrived is
                    # not a failure of the guest, and it is not complete either.
                    stats["incomplete"] += 1
                    annotate(
                        out_fd,
                        digest,
                        stats,
                        label,
                        "%s incomplete=deadline-reached" % label,
                        max_bytes,
                    )
                    break
            os.fsync(out_fd)
        except BaseException:
            os.close(out_fd)
            discard(staging_fd, name)
            raise
        os.close(out_fd)
        return {
            "op": "capture",
            "name": name,
            "size": stats["bytes"],
            "sha256": digest.hexdigest(),
            "truncated": stats["truncated"],
            "timed_out": stats["timed_out"],
            "sources_failed": stats["failed"],
            "sources_incomplete": stats["incomplete"],
            "sources_ok": len(parsed) - stats["failed"] - stats["incomplete"],
            # Complete means every source produced what it was asked for. A
            # source that could not start, that exited non-zero or that was cut
            # short all leave the report partial, and that is stated rather than
            # left for a caller to infer from a byte count.
            "complete": not (
                stats["truncated"]
                or stats["timed_out"]
                or stats["incomplete"]
                or stats["failed"]
            ),
            "sources": reported,
        }
    finally:
        os.close(staging_fd)


OPERATIONS = {
    "list": op_list,
    "open": op_open,
    "snapshot": op_snapshot,
    "capture": op_capture,
}


def errno_name(error):
    return errno.errorcode.get(error.errno, "EIO")


def emit(payload):
    try:
        sys.stdout.write(
            json.dumps(payload, ensure_ascii=True, separators=(",", ":")) + "\n"
        )
        sys.stdout.flush()
    except Exception:
        pass


def main(argv):
    if len(argv) != 2:
        raise HelperError(
            "usage: artifact-helper.py <request-json>", CODE_UNSAFE_PATH
        )
    try:
        request = json.loads(argv[1])
    except ValueError:
        raise HelperError("request is not valid JSON", CODE_UNSAFE_PATH)
    if not isinstance(request, dict):
        raise HelperError("request must be a JSON object", CODE_UNSAFE_PATH)
    operation = OPERATIONS.get(request.get("op"))
    if operation is None:
        raise HelperError("unsupported operation", CODE_UNSAFE_PATH)
    result = operation(request)
    result["ok"] = True
    emit(result)


if __name__ == "__main__":
    try:
        main(sys.argv)
    except HelperError as error:
        emit(
            {
                "ok": False,
                "code": getattr(error, "code", CODE_TRANSPORT),
                "error": str(error)[:MAX_ERROR],
            }
        )
        sys.exit(1)
    except NotRegular as error:
        emit(
            {
                "ok": False,
                "code": getattr(error, "code", CODE_NOT_FOUND),
                "error": str(error)[:MAX_ERROR],
            }
        )
        sys.exit(1)
    except OSError as error:
        emit(
            {
                "ok": False,
                "code": code_for_errno(error.errno if error.errno else errno.EIO),
                "error": "filesystem error: %s" % errno_name(error),
            }
        )
        sys.exit(1)
    except Exception:
        emit({"ok": False, "code": CODE_TRANSPORT, "error": "capture failed"})
        sys.exit(1)