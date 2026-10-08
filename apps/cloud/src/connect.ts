import { authentication, type Context, HttpError } from "./common.ts";
import { token } from "./crypto.ts";
import { idSchema } from "./schemas.ts";
export async function connectPage(ctx: Context) {
  const url = new URL(ctx.request.url);
  if (url.pathname !== "/cloud/connect" || ctx.request.method !== "GET")
    return null;
  if ([...url.searchParams.keys()].some((k) => k !== "link_id"))
    throw new HttpError(400, "invalid_request", "Invalid link request");
  const id = idSchema.parse(url.searchParams.get("link_id"));
  try {
    await authentication(ctx);
  } catch (e) {
    if (e instanceof HttpError && e.status === 401)
      return new Response(null, {
        status: 302,
        headers: {
          location: `${ctx.env.APP_ORIGIN}/v1/auth/github?return_to=${encodeURIComponent(`/cloud/connect?link_id=${id}`)}`,
        },
      });
    throw e;
  }
  const nonce = token();
  // No client_name, profile, tenant labels or user input interpolated into HTML.
  // Dynamic values enter textContent and option.textContent exclusively.
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Connect SwarmForge CLI</title><body><main><h1>Connect SwarmForge CLI</h1><p>Approve only a request you started. Compare the installation name and enter the pairing code shown by your CLI.</p><p id="details">Loading request…</p><form id="pair"><label>Pairing code <input id="code" required autocomplete="off" maxlength="12"></label><p><label>Organization <select id="organization" required></select></label></p><button id="approve" type="submit" disabled>Approve connection</button> <button id="deny" type="button" disabled>Deny</button></form><p id="result" role="status"></p></main><script nonce="${nonce}">
const id=new URL(location.href).searchParams.get('link_id'),details=document.getElementById('details'),result=document.getElementById('result'),select=document.getElementById('organization');let csrf='',link;
async function api(path,options={}){const r=await fetch(path,{credentials:'same-origin',...options});if(!r.ok)throw new Error('Request failed. Refresh the page or start a new CLI login.');return r.json();}
async function initialize(){const session=await api('/v1/session');csrf=session.csrf_token;link=await api('/v1/cli-links/'+id);details.textContent='Installation: '+link.client_name+' · Access: '+link.scopes.join(', ')+' · Status: '+link.state;let next='/v1/me?limit=100';while(next){const account=await api(next);for(const m of account.memberships){if(link.requested_tenant_id&&m.tenant_id!==link.requested_tenant_id)continue;const org=await api('/v1/tenants/'+m.tenant_id);const option=document.createElement('option');option.value=m.tenant_id;option.textContent=org.display_name+' ('+m.role+')';select.append(option);}next=account.next_cursor?'/v1/me?limit=100&cursor='+encodeURIComponent(account.next_cursor):null;}document.getElementById('approve').disabled=link.state!=='pending'||!select.options.length;document.getElementById('deny').disabled=link.state!=='pending';}
async function decide(deny){document.getElementById('approve').disabled=true;document.getElementById('deny').disabled=true;try{const data={user_code:document.getElementById('code').value.trim()};if(!deny)data.tenant_id=select.value;await api('/v1/cli-links/'+id+(deny?'/deny':'/approve'),{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf,'Idempotency-Key':crypto.randomUUID()},body:JSON.stringify(data)});result.textContent=deny?'Connection denied.':'Connection approved. Return to your CLI.';document.getElementById('code').value='';}catch(e){result.textContent=e.message;document.getElementById('approve').disabled=!select.options.length;document.getElementById('deny').disabled=false;}}
document.getElementById('pair').addEventListener('submit',e=>{e.preventDefault();decide(false);});document.getElementById('deny').addEventListener('click',()=>decide(true));initialize().catch(e=>{result.textContent=e.message;});
</script></body></html>`;
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
    },
  });
}
