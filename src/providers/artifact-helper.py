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
MAX_ERROR = 512
EXCLUDED = (".git", "node_modules")
MAX_SOURCES = 8
# Nothing inherited from the caller's environment: no secrets, no PYTHON* or
# GIT_* overrides, no locale surprises in the metadata.
CHILD_ENV = {
    "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    "HOME": "/root",
    "LC_ALL": "C",
    "GIT_OPTIONAL_LOCKS": "0",
    "GIT_TERMINAL_PROMPT": "0",
}


class HelperError(Exception):
    """A refusal. The message names a rule, never file contents."""


class NotRegular(Exception):
    """The final component exists but is not a regular file."""


def require_int(value, name, minimum=0, maximum=(1 << 62)):
    if isinstance(value, bool) or not isinstance(value, int):
        raise HelperError("%s must be an integer" % name)
    if value < minimum or value > maximum:
        raise HelperError("%s is out of range" % name)
    return value


def field(request, name):
    if name not in request:
        raise HelperError("%s is required" % name)
    return request[name]


def require_name(value):
    if not isinstance(value, str) or not NAME_RE.match(value):
        raise HelperError("staged file name is invalid")
    return value


def clean_relative(path, allow_empty=False):
    if not isinstance(path, str):
        raise HelperError("path must be a string")
    if len(path.encode("utf-8", "surrogateescape")) > 1024:
        raise HelperError("path exceeds 1024 bytes")
    if path.startswith("/") or "\\" in path or "\x00" in path:
        raise HelperError("path must be a relative workspace path")
    parts = [part for part in path.split("/") if part]
    if not parts and not allow_empty:
        raise HelperError("path must not be empty")
    if len(parts) > 32:
        raise HelperError("path has more than 32 components")
    for part in parts:
        if part in (".", ".."):
            raise HelperError("path must not traverse directories")
        if any(ord(ch) < 32 or ord(ch) == 127 for ch in part):
            raise HelperError("path contains a control character")
    return parts


def root_path(root):
    if not isinstance(root, str) or not root.startswith("/"):
        raise HelperError("root must be an absolute path")
    if len(root.encode("utf-8", "surrogateescape")) > 4096:
        raise HelperError("root is too long")
    if "\\" in root or "\x00" in root:
        raise HelperError("root contains an invalid character")
    parts = [part for part in root.split("/") if part and part != "."]
    for part in parts:
        if part == ".." or any(ord(ch) < 32 or ord(ch) == 127 for ch in part):
            raise HelperError("root must not traverse directories")
    return "/" + "/".join(parts)


def open_dir_at(root, parts):
    """Open the directory named by `parts`, one descriptor-relative step at a time."""
    try:
        fd = os.open(root, DIR_FLAGS)
    except OSError as error:
        raise HelperError("root is not an accessible directory: %s" % errno_name(error))
    try:
        for name in parts:
            try:
                nxt = os.open(name, DIR_FLAGS, dir_fd=fd)
            except OSError:
                raise HelperError("path component is missing or not a directory")
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
        except OSError:
            raise NotRegular("artifact is missing or is not a regular file")
    finally:
        os.close(parent)
    if not statmod.S_ISREG(os.fstat(fd).st_mode):
        os.close(fd)
        raise NotRegular("artifact is not a regular file")
    return fd


def lstat_at(root, parts):
    parent = open_dir_at(root, parts[:-1])
    try:
        try:
            return os.lstat(parts[-1], dir_fd=parent)
        except OSError:
            raise NotRegular("artifact is missing")
    finally:
        os.close(parent)


def open_staging(staging):
    if not isinstance(staging, str) or not staging.startswith("/"):
        raise HelperError("staging must be an absolute path")
    if "\x00" in staging or "\\" in staging:
        raise HelperError("staging contains an invalid character")
    try:
        fd = os.open(staging, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    except OSError:
        raise HelperError("staging directory is not accessible")
    # Staged bytes are the only copy of the artifact in the guest: they must not
    # be reachable by the worker's own user or by anyone else on the guest.
    if statmod.S_IMODE(os.fstat(fd).st_mode) & 0o077:
        os.close(fd)
        raise HelperError("staging directory is not private")
    return fd


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
        raise HelperError("source changed during capture")
    try:
        again = open_regular_at(root, parts)
    except NotRegular:
        raise HelperError("source changed during capture")
    try:
        current = os.fstat(again)
        if (current.st_dev, current.st_ino) != (before.st_dev, before.st_ino):
            raise HelperError("source changed during capture")
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
            raise HelperError(str(error))
        try:
            before = os.fstat(fd)
            total = before.st_size
            if offset > total:
                raise HelperError("offset is past the end of the artifact")
            window = total - offset
            if length is not None:
                window = min(window, length)
            if window > max_bytes:
                raise HelperError("artifact exceeds the configured maximum size")
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
        raise HelperError("path is deeper than the configured maximum depth")
    offset = require_int(request.get("offset", 0), "offset", 0)
    limit = require_int(request.get("limit", 100), "limit", 1)
    dir_fd = open_dir_at(root, parts)
    try:
        names = sorted(os.listdir(dir_fd))
        truncated = len(names) > max_entries
        names = names[:max_entries]
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
            raise HelperError("snapshot source exceeds the configured maximum byte limit")
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
            raise HelperError("snapshot exceeds the configured maximum size")
    finally:
        os.close(fd)


def add_directory(tar, root, parts, arcname, state, max_bytes, max_entries, max_depth, strict):
    if parts:
        try:
            info = lstat_at(root, parts)
        except NotRegular:
            if strict:
                raise HelperError("snapshot source is missing")
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
                raise HelperError("snapshot source is not a regular file or directory")
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
        for name in sorted(os.listdir(dir_fd)):
            if name in EXCLUDED:
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
        raise HelperError("paths is invalid")
    selected = [clean_relative(item) for item in raw_paths]
    for parts in selected:
        if len(parts) > max_depth:
            raise HelperError("path is deeper than the configured maximum depth")
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
                        raise HelperError("snapshot exceeds the configured maximum size")
            os.fsync(out_fd)
        except BaseException:
            os.close(out_fd)
            discard(staging_fd, name)
            raise
        os.close(out_fd)
        staged = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=staging_fd)
        try:
            if os.fstat(staged).st_size > max_bytes:
                raise HelperError("snapshot exceeds the configured maximum size")
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


def run_bounded(argv, dst_fd, budget, digest, stats, root, deadline):
    """Copy a command's stdout into the staged file, strictly inside `budget`."""
    if budget <= 0:
        stats["truncated"] = True
        return
    try:
        proc = subprocess.Popen(
            argv,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            cwd=root,
            env=CHILD_ENV,
            start_new_session=True,
        )
    except OSError:
        stats["failed"] += 1
        return
    total = 0
    try:
        while True:
            remaining = deadline - _now()
            if remaining <= 0:
                stats["timed_out"] = True
                break
            ready, _, _ = select.select([proc.stdout], [], [], min(remaining, 1.0))
            if not ready:
                if proc.poll() is not None:
                    break
                continue
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
    finally:
        try:
            proc.stdout.close()
        except OSError:
            pass
        if proc.poll() is None:
            # The child writes to a pipe we stop reading; stop the child too.
            try:
                os.killpg(proc.pid, 9)
            except OSError:
                proc.kill()
        proc.wait()
        if proc.returncode:
            stats["failed"] += 1
    stats["bytes"] += total


def _now():
    return time.monotonic()


def op_capture(request):
    root = root_path(field(request, "root"))
    max_bytes = require_int(field(request, "max_bytes"), "max_bytes", 1)
    timeout = require_int(request.get("timeout_ms", 30000), "timeout_ms", 100, 600000)
    sources = request.get("sources")
    if not isinstance(sources, list) or not sources or len(sources) > MAX_SOURCES:
        raise HelperError("sources is invalid")
    parsed = []
    for source in sources:
        if not isinstance(source, dict):
            raise HelperError("source is invalid")
        argv = source.get("argv")
        if not isinstance(argv, list) or not argv or len(argv) > 64:
            raise HelperError("source argv is invalid")
        for argument in argv:
            if not isinstance(argument, str) or not argument or "\x00" in argument:
                raise HelperError("source argv is invalid")
            if len(argument) > 1024:
                raise HelperError("source argv is invalid")
        parsed.append(argv)
    name = field(request, "name")
    staging_fd = open_staging(field(request, "staging"))
    try:
        out_fd = staged_fd(staging_fd, name)
        digest = hashlib.sha256()
        stats = {"truncated": False, "timed_out": False, "failed": 0, "bytes": 0}
        try:
            deadline = _now() + timeout / 1000.0
            for argv in parsed:
                run_bounded(
                    argv,
                    out_fd,
                    max_bytes - stats["bytes"],
                    digest,
                    stats,
                    root,
                    deadline,
                )
                if stats["timed_out"]:
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
        raise HelperError("usage: artifact-helper.py <request-json>")
    try:
        request = json.loads(argv[1])
    except ValueError:
        raise HelperError("request is not valid JSON")
    if not isinstance(request, dict):
        raise HelperError("request must be a JSON object")
    operation = OPERATIONS.get(request.get("op"))
    if operation is None:
        raise HelperError("unsupported operation")
    result = operation(request)
    result["ok"] = True
    emit(result)


if __name__ == "__main__":
    try:
        main(sys.argv)
    except HelperError as error:
        emit({"ok": False, "error": str(error)[:MAX_ERROR]})
        sys.exit(1)
    except OSError as error:
        emit({"ok": False, "error": "filesystem error: %s" % errno_name(error)})
        sys.exit(1)
    except Exception:
        emit({"ok": False, "error": "capture failed"})
        sys.exit(1)