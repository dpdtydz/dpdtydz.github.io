(() => {
  'use strict';
  const login=document.getElementById('login-view');
  const workspace=document.getElementById('workspace-view');
  const form=document.getElementById('login-form');
  const input=document.getElementById('admin-password');
  const button=document.getElementById('login-submit');
  const error=document.getElementById('login-error');
  const bytes=value=>Uint8Array.from(atob(value),character=>character.charCodeAt(0));
  const base64=value=>btoa(String.fromCharCode(...new Uint8Array(value)));
  const derive=async(password,salt,iterations)=>crypto.subtle.deriveKey({name:'PBKDF2',salt,iterations,hash:'SHA-256'},await crypto.subtle.importKey('raw',new TextEncoder().encode(password),'PBKDF2',false,['deriveKey']),{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
  const message=value=>{error.textContent=value;error.hidden=!value;};
  let pending=false,attempts=0;
  if (!window.isSecureContext || !crypto.subtle) {message('HTTPS와 최신 브라우저가 필요합니다.');return;}
  button.disabled=false;
  form.addEventListener('submit',async event=>{
    event.preventDefault();if(pending)return;
    pending=true;button.disabled=true;message('');
    let password=input.value;
    input.value='';
    try {
      const response=await fetch('/assets/admin/workspace.enc.json',{cache:'no-store',credentials:'omit'});
      if(!response.ok)throw Error('관리 화면을 불러오지 못했습니다. 잠시 후 다시 시도해주세요.');
      const envelope=await response.json();
      let source;
      try {const key=await derive(password,bytes(envelope.salt),envelope.iterations);source=await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes(envelope.iv)},key,bytes(envelope.data));}
      catch {attempts++;await new Promise(resolve=>setTimeout(resolve,Math.min(attempts*350,2000)));throw Error('암호가 올바르지 않습니다.');}
      let salt=localStorage.getItem('superhome:vault-salt:v1');
      if(!salt){salt=base64(crypto.getRandomValues(new Uint8Array(16)));localStorage.setItem('superhome:vault-salt:v1',salt);}
      const vaultKey=await derive(password,bytes(salt),600000);
      password='';
      let writes=Promise.resolve();
      const vault={
        async read(){const raw=localStorage.getItem('superhome:drafts:v1');if(!raw)return {drafts:{}};try{const envelope=JSON.parse(raw);const data=await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes(envelope.iv)},vaultKey,bytes(envelope.data));return JSON.parse(new TextDecoder().decode(data));}catch{throw Error('이 브라우저의 초안을 복호화하지 못했습니다. 브라우저 데이터를 지우지 말고 기존 암호를 확인해주세요.');}},
        write(value){const snapshot=JSON.stringify(value);const operation=writes.catch(()=>{}).then(async()=>{const iv=crypto.getRandomValues(new Uint8Array(12));const encrypted=await crypto.subtle.encrypt({name:'AES-GCM',iv},vaultKey,new TextEncoder().encode(snapshot));const data=new Uint8Array(encrypted);let binary='';for(let i=0;i<data.length;i+=8192)binary+=String.fromCharCode(...data.subarray(i,i+8192));localStorage.setItem('superhome:drafts:v1',JSON.stringify({iv:base64(iv),data:btoa(binary)}));});writes=operation;return operation;},
        flush(){return writes;}
      };
      const moduleURL=URL.createObjectURL(new Blob([source],{type:'text/javascript'}));
      let app;try{app=await import(moduleURL);}finally{URL.revokeObjectURL(moduleURL);}
      login.hidden=true;workspace.hidden=false;
      await app.mount({root:workspace,vault,lock:()=>location.reload()});
    } catch(failure) {
      password='';login.hidden=false;workspace.hidden=true;workspace.replaceChildren();message(failure.message || '관리 화면을 열지 못했습니다.');input.focus();
    } finally {pending=false;button.disabled=false;}
  });
})();
