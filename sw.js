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

/* Push notifications (Firebase Cloud Messaging, data messages): show them, and open the app on today's card when tapped */
self.addEventListener("push",e=>{let m={};try{m=e.data?e.data.json():{}}catch(_){m={}}
  const d=m.data||m||{},n=m.notification||{};
  const title=d.title||n.title||"ניהול צוות טכנאים",body=d.body||n.body||"";
  e.waitUntil(self.registration.showNotification(title,{body,icon:"icon-192.png",badge:"icon-192.png",tag:d.tag||"today",data:{url:d.url||"./?today=1"},lang:"he",dir:"rtl"}))});
self.addEventListener("notificationclick",e=>{e.notification.close();const url=new URL((e.notification.data&&e.notification.data.url)||"./?today=1",self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({type:"window",includeUncontrolled:true}).then(list=>{for(const c of list){if("focus" in c){c.navigate(url).catch(()=>{});return c.focus()}}return self.clients.openWindow(url)}))});
