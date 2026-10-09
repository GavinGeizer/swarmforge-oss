import {randomUUID} from 'node:crypto';
import {HostedTaskClient} from '/tmp/swarmforge-phase2b2-runtime/src/hosted-client';
const tenant=randomUUID(),worker=randomUUID(),requestIds:string[]=[];
const transport=(async (_url:unknown,init:RequestInit)=>{const body=JSON.parse(init.body as string);requestIds.push(body.request_id); return new Response('{}',{status:409,headers:{'content-type':'application/json'}})}) as typeof fetch;
const client=new HostedTaskClient('https://api.example.invalid','sfexec_'+'a'.repeat(43),tenant,transport); const key=randomUUID();
for(let i=0;i<2;i++) await client.submitTask(worker,60000,100,key).catch(()=>{});
console.log(JSON.stringify({key,firstRequestId:requestIds[0],secondRequestId:requestIds[1],retryPayloadStable:requestIds[0]===requestIds[1]}));
