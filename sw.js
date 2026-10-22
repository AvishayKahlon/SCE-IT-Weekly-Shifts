/* Serves calendar files generated on the device – nothing is sent to any server.
   cal/event.ics?d=<base64url ICS> → text/calendar, so iOS Safari shows "Add to Calendar". Everything else goes to the network untouched. */
self.addEventListener("install",()=>self.skipWaiting());
self.addEventListener("activate",e=>e.waitUntil(self.clients.claim()));
self.addEventListener("fetch",e=>{const u=new URL(e.request.url);
  if(u.origin!==location.origin||!/\/cal\/[^/]*\.ics$/.test(u.pathname))return;
  const d=u.searchParams.get("d")||"";
  try{const b=atob(d.replace(/-/g,"+").replace(/_/g,"/")),bytes=Uint8Array.from(b,c=>c.charCodeAt(0));
    e.respondWith(new Response(bytes,{headers:{"Content-Type":"text/calendar; charset=utf-8","Cache-Control":"no-store"}}))}
  catch(_){e.respondWith(new Response("bad calendar data",{status:400}))}});
