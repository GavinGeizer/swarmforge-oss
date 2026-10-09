import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
function reading(){return {boot:readFileSync('/proc/uptime','utf8').split(' ')[0],hrtime:String(process.hrtime.bigint()),performance:performance.now()};}
console.log(JSON.stringify({parentBefore:reading()}));
const child=spawnSync(process.execPath,['--no-env-file','--config=/dev/null','-e',"const fs=require('node:fs');console.log(JSON.stringify({child:{boot:fs.readFileSync('/proc/uptime','utf8').split(' ')[0],hrtime:String(process.hrtime.bigint()),performance:performance.now()}}))"],{env:{PATH:'/usr/bin:/bin'},encoding:'utf8'});
console.log(child.stdout.trim());
console.log(JSON.stringify({parentAfter:reading(),childStatus:child.status}));
