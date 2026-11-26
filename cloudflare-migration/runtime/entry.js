import {createCore} from './core.js';
import {createLegacy} from './legacy.js';
import {serveMedia} from './media.js';
import {orderActions,deleteOrder} from './extra-routes.js';

export default {
  async fetch(request,env){
    const path=new URL(request.url).pathname;
    if(path==='/delete-order')return deleteOrder(request,env);
    if(path==='/order-actions')return orderActions(request,env);
    if(path==='/api-core')return createCore(env)(request);
    if(path==='/api')return createLegacy(env)(request);
    if(path.startsWith('/media/'))return serveMedia(request,env);
    if(path==='/health')return new Response(JSON.stringify({ok:true,service:'meehoasg-ops-staging'}),{headers:{'content-type':'application/json'}});
    return env.ASSETS.fetch(request);
  }
};
