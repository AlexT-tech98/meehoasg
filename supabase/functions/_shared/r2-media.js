import { AwsClient } from 'npm:aws4fetch@1.0.20';

const PATH = /^(order-images|settlement-bills)\/[0-9a-f-]{36}(?:\.preview)?\.(?:jpg|png|webp)$/;

export function createR2Media({accountId,accessKeyId,secretAccessKey,bucket,fetcher=fetch}) {
  if (!/^[0-9a-f]{32}$/.test(accountId || '') || !/^[a-z0-9-]+$/.test(bucket || '') || !accessKeyId || !secretAccessKey) {
    throw new Error('R2_NOT_CONFIGURED');
  }
  const signer = new AwsClient({service:'s3',region:'auto',accessKeyId,secretAccessKey});
  const base = `https://${accountId}.r2.cloudflarestorage.com/${bucket}/`;

  function key(kind,path) {
    const prefix = kind === 'sample' ? 'order-images' : kind === 'bill' ? 'settlement-bills' : '';
    const value = `${prefix}/${path}`;
    if (!prefix || !PATH.test(value)) throw new Error('R2_IMAGE_PATH_INVALID');
    return value;
  }

  async function signedUrl(method,objectKey,{expiresSeconds=900,contentType}={}) {
    if (!PATH.test(objectKey) || !Number.isInteger(expiresSeconds) || expiresSeconds<1 || expiresSeconds>3600) {
      throw new Error('R2_IMAGE_REQUEST_INVALID');
    }
    if (!['GET','PUT','HEAD','DELETE'].includes(method)) throw new Error('R2_IMAGE_METHOD_INVALID');
    const url = new URL(base + objectKey);
    url.searchParams.set('X-Amz-Expires',String(expiresSeconds));
    const headers = method === 'PUT' ? {'Content-Type':contentType} : {};
    const mimeForExtension={jpg:'image/jpeg',png:'image/png',webp:'image/webp'};
    if (method === 'PUT' && mimeForExtension[objectKey.split('.').pop()] !== contentType) throw new Error('R2_IMAGE_TYPE_INVALID');
    const request = new Request(url,{method,headers});
    return (await signer.sign(request,{aws:{signQuery:true,allHeaders:method==='PUT'}})).url.toString();
  }

  async function verifyUpload(objectKey) {
    const response = await fetcher(await signedUrl('HEAD',objectKey,{expiresSeconds:60}),{method:'HEAD'});
    const size = Number(response.headers.get('content-length'));
    if (!response.ok || !Number.isFinite(size) || size<1 || size>5*1024*1024) throw new Error('R2_UPLOAD_NOT_READY');
    return size;
  }

  async function exists(objectKey) {
    if(!PATH.test(objectKey))return false;
    const response = await fetcher(await signedUrl('HEAD',objectKey,{expiresSeconds:60}),{method:'HEAD'});
    if(response.ok)return true;
    if(response.status===404)return false;
    throw new Error(`R2_READ_CHECK_${response.status}`);
  }

  async function discard(value) {
    const objectKey=parseReference(value);
    if(!objectKey)return;
    await fetcher(await signedUrl('DELETE',objectKey,{expiresSeconds:60}),{method:'DELETE'});
  }

  function reference(objectKey) {
    if (!PATH.test(objectKey)) throw new Error('R2_IMAGE_PATH_INVALID');
    return `r2://${bucket}/${objectKey}`;
  }

  function parseReference(value) {
    const prefix = `r2://${bucket}/`;
    const objectKey = String(value || '').startsWith(prefix) ? String(value).slice(prefix.length) : '';
    return PATH.test(objectKey) ? objectKey : null;
  }

  return {key,signedUrl,verifyUpload,exists,discard,reference,parseReference};
}
