// Retired recovery route: preserve the deployed no-write behavior.
Deno.serve(()=>new Response('Not found',{status:404,headers:{'Cache-Control':'no-store'}}));
