import assert from 'node:assert/strict';
import {localFixture} from '/tmp/swarmforge-phase2b2-rotation-window/apps/cloud/test/local-fixture.ts';
const h=await localFixture();try {const a=await h.login(),w=await h.enrolledWorker(a),s=await h.registerSupervisor(a,w.worker_id),k=crypto.randomUUID(),headers={authorization:`Bearer ${s.credential}`,'idempotency-key':k};
const r=await h.request('/v1/supervisor/me/rotate',headers,'POST',{});assert.equal(r.status,200);const newReply=await r.json() as any;
// Simulate a request arriving near the end of the existing bounded recovery window.
h.db.sqlite.query('UPDATE hosted_supervisor_credentials SET expires_at=? WHERE credential_id=?').run(Date.now()+100,s.credential_id);
h.db.sqlite.query('UPDATE hosted_supervisor_rotations SET expires_at=? WHERE previous_credential_id=?').run(Date.now()+100,s.credential_id);
const original=h.db.execute.bind(h.db);let delayed=false;
h.db.execute=((stmt:any)=>{if(stmt.sql.startsWith('SELECT r.result_ciphertext')) {delayed=true;Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,150);}return original(stmt);}) as any;
const reply=await h.request('/v1/supervisor/me/rotate',headers,'POST',{});const value=await reply.json() as any;
const state=h.db.sqlite.query("SELECT c.expires_at old_expiry,r.expires_at recovery_expiry,CAST(strftime('%s','now') AS INTEGER)*1000+CAST(substr(strftime('%f','now'),4,3) AS INTEGER) sql_time FROM hosted_supervisor_credentials c JOIN hosted_supervisor_rotations r ON c.credential_id=r.previous_credential_id WHERE c.credential_id=?").get(s.credential_id) as any;
console.log(JSON.stringify({delayed,status:reply.status,same_successor:value.credential===newReply.credential,old_expired_at_sql:state.old_expiry<=state.sql_time,recovery_expired_at_sql:state.recovery_expiry<=state.sql_time}));assert(delayed);assert(state.old_expiry<=state.sql_time);assert(state.recovery_expiry<=state.sql_time);
} finally {h.close();}
