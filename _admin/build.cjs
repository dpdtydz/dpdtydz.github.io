const fs=require('fs');
const path=require('path');
const crypto=require('crypto');
const esbuild=require('esbuild');

async function main(){
  const password=fs.readFileSync(0,'utf8').replace(/[\r\n]+$/,'');
  if(!password)throw Error('Pass the administrator password through stdin.');
  const result=await esbuild.build({entryPoints:[path.join(__dirname,'workspace.mjs')],bundle:true,format:'esm',platform:'browser',target:['es2022'],minify:true,write:false,legalComments:'inline'});
  const salt=crypto.randomBytes(16),iv=crypto.randomBytes(12),iterations=600000;
  const key=crypto.pbkdf2Sync(password,salt,iterations,32,'sha256');
  const cipher=crypto.createCipheriv('aes-256-gcm',key,iv);
  const data=Buffer.concat([cipher.update(result.outputFiles[0].contents),cipher.final(),cipher.getAuthTag()]);
  key.fill(0);
  const fingerprint=crypto.createHash('sha256');
  for(const name of ['workspace.mjs','core.mjs','build.cjs','package-lock.json'])fingerprint.update(fs.readFileSync(path.join(__dirname,name),'utf8').replace(/\r\n/g,'\n'));
  const sourceHash=fingerprint.digest('hex');
  const output=path.resolve(__dirname,'../assets/admin/workspace.enc.json');
  fs.mkdirSync(path.dirname(output),{recursive:true});
  fs.writeFileSync(output,JSON.stringify({version:1,sourceHash,algorithm:'AES-GCM',kdf:'PBKDF2-SHA256',iterations,salt:salt.toString('base64'),iv:iv.toString('base64'),data:data.toString('base64')})+'\n');
  console.log(`Encrypted administrator bundle: ${data.length} bytes. Password was not written to disk.`);
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
