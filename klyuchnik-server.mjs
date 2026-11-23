import http from 'node:http';
import {spawn} from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { connectN8n, loadConnection } from './n8n-connect.mjs';
import { listMetrikaGoals } from './metrika.mjs';
import {connectDirect,directStatus,previewDirect,transferDirect,directTransferStatus} from './direct.mjs';

const host = '127.0.0.1';
const port = Number(process.env.KLYUCHNIK_PORT || 8787);
const origin = 'http://' + host + ':' + port;
let connection = await loadConnection();
let configuring = false;

const html = await readFile(new URL('./klyuchnik-wordstat.html', import.meta.url));
const requiredFiles = ['01_all_phrases.csv', '02_empty_phrases.csv', '03_clean_no_empty.csv', '04_irrelevant.csv', '05_final_clean.csv'];
const jobs = new Map();
let busy = false;

function json(res, status, data) {
  res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
  res.end(JSON.stringify(data));
}

async function bodyOf(req, limit=32000) {
  const buffers = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('Слишком много данных для запроса.');
    buffers.push(chunk);
  }
  try{return JSON.parse(Buffer.concat(buffers).toString('utf8'));}catch{throw Error('Ожидался JSON.');}
}

function validateJob(input){
  const {masks,niche,regions} = input;
  if (!Array.isArray(masks) || !masks.length || masks.length>50 || masks.some(mask=>typeof mask!=='string'||!mask.trim()||mask.length>1000)) {
    throw new Error('Передайте от 1 до 50 базовых масок.');
  }
  if (typeof niche!=='string'||!niche.trim()||niche.length>500) throw new Error('Проверьте тематику проекта.');
  if (!Array.isArray(regions)||regions.length>50||regions.some(region=>typeof region!=='string'||!/^\d{1,12}$/.test(region))) {
    throw new Error('Передайте числовые коды регионов Wordstat.');
  }
  return {masks:masks.map(mask=>mask.trim()),niche:niche.trim(),regions:[...new Set(regions)]};
}

function connectionStatus(){
  return {available:Boolean(connection),name:connection?.name??'',url:connection?.base??'',
    campaignAvailable:Boolean(connection?.campaign),campaignName:connection?.campaign?.name??''};
}

async function callWorkflow({webhook,token},input,timeout){
  let reply;
  try {
    reply=await fetch(webhook,{
      method:'POST',redirect:'error',signal:AbortSignal.timeout(timeout),
      headers:{'Content-Type':'application/json',...(token?{'X-Klyuchnik-Token':token}:{})},
      body:JSON.stringify(input)
    });
  }catch(error){
    throw Error(error.name==='TimeoutError'?'n8n не успел завершить воркфлоу. Проверьте выполнение в n8n.':
      'Не удалось связаться с локальным n8n. Проверьте, что он запущен.');
  }
  if(!reply.ok){
    const hints={401:'Проверьте значение заголовка X-Klyuchnik-Token.',403:'Проверьте настройку Header Auth.',404:'Проверьте Production URL и активируйте воркфлоу.'};
    throw Error('n8n ответил HTTP '+reply.status+'. '+(hints[reply.status]||'Откройте последнее выполнение воркфлоу в n8n, чтобы увидеть причину.'));
  }
  let result;
  try{result=await reply.json();}catch{throw Error('n8n вернул ответ без JSON. Проверьте настройки воркфлоу.');}
  return Array.isArray(result)?result[0]:result;
}

function campaignInput(input){
  if(!input?.project||!input.settings||!Array.isArray(input.groups)||!input.groups.length||input.groups.length>100){
    throw Error('Для подготовки кампании передайте данные проекта и от 1 до 100 групп.');
  }
  let total=0;
  const ids=new Set();
  for(const group of input.groups){
    if(typeof group?.id!=='string'||ids.has(group.id)||typeof group.name!=='string'||!group.name.trim()||
        !Array.isArray(group.keywords)||!group.keywords.length||
        group.keywords.some(phrase=>typeof phrase!=='string'||!phrase.trim()||phrase.length>1000)){
      throw Error('В воркфлоу кампании нужны уникальные ID групп, названия и ключевые фразы.');
    }
    ids.add(group.id);
    total+=group.keywords.length;
  }
  if(total>20000)throw Error('Агент кампании принимает до 20 000 фраз за раз.');
  return {...input,action:'prepare-campaign',version:1};
}

function campaignOutput(result,expected){
  if(result?.version!==1||!Array.isArray(result.groups)||result.groups.length!==expected.groups.length){
    throw Error('Воркфлоу кампании должен вернуть JSON версии 1 с результатом для каждой группы.');
  }
  const ids=new Set(expected.groups.map(group=>group.id));
  const read=(value,max)=>typeof value==='string'&&value.trim()&&value.trim().length<=max&&!/[\u0000-\u001f\u007f]/.test(value.trim());
  const groups=result.groups.map(group=>{
    if(!ids.delete(group?.id)||!read(group.title,56)||!read(group.description,81)||!Array.isArray(group.negative)||
        group.negative.length>12||group.negative.some(phrase=>!read(phrase,100))){
      throw Error('Воркфлоу вернул некорректное объявление или минус-фразы. Проверьте последнее выполнение в n8n.');
    }
    return {id:group.id,title:group.title.trim(),description:group.description.trim(),
      negative:[...new Set(group.negative.map(phrase=>phrase.trim()))]};
  });
  return {groups};
}

async function run(job,input,target) {
  try {
    const result=await callWorkflow(target,input,15*60*1000);
    if (!requiredFiles.every(name=>typeof result?.files?.[name]==='string')) {
      throw new Error('n8n завершился без полного набора из пяти CSV. Проверьте воркфлоу и его последнее выполнение.');
    }
    job.status='done';
    job.files=Object.fromEntries(requiredFiles.map(name=>[name,result.files[name]]));
    job.warning=typeof result.warning==='string'?result.warning:'';
  } catch (error) {
    job.status='error';
    job.message=error.message;
  } finally {
    busy=false;
    setTimeout(()=>jobs.delete(job.id),15*60*1000).unref();
  }
}

const server = http.createServer(async (req,res)=>{
  if (req.headers.host !== new URL(origin).host) {json(res,403,{message:'Откройте приложение по '+origin});return;}
  const path = new URL(req.url,origin).pathname;
  if (req.method==='GET' && path==='/') {
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
    res.end(html);return;
  }
  if (req.method==='GET' && path==='/api/semantics/status') {
    json(res,200,connectionStatus());return;
  }
  if(req.method==='POST'&&(path==='/api/semantics/jobs'||path==='/api/semantics/connect'||path==='/api/campaign/prepare'||path==='/api/metrika/goals'||path.startsWith('/api/direct/'))&&
      (req.headers.origin!==origin||!/^application\/json(?:;|$)/i.test(req.headers['content-type']||''))){
    json(res,403,{message:'Откройте настройки в окне «Ключника».'});return;
  }
  if(req.method==='GET'&&path==='/api/direct/status'){
    try{json(res,200,await directStatus());}catch{json(res,500,{message:'Не удалось прочитать подключение Директа.'});}
    return;
  }
  if(req.method==='POST'&&path==='/api/direct/connect'){
    try{json(res,200,await connectDirect(await bodyOf(req)));}catch(error){json(res,400,{message:error.message});}
    return;
  }
  if(req.method==='POST'&&(path==='/api/direct/preview'||path==='/api/direct/transfer')){
    try{
      const data=await bodyOf(req,4*1024*1024);
      if(path.endsWith('/preview'))json(res,200,previewDirect(data));
      else json(res,200,await transferDirect(data.id,data.draft));
    }catch(error){json(res,400,{message:error.message});}
    return;
  }
  if(req.method==='GET'&&/^\/api\/direct\/transfer\/[\da-f-]{36}$/i.test(path)){
    try{json(res,200,await directTransferStatus(path.split('/').pop()));}catch(error){json(res,400,{message:error.message});}
    return;
  }
  if(req.method==='POST'&&path==='/api/metrika/goals'){
    try{json(res,200,{goals:await listMetrikaGoals(await bodyOf(req))});}
    catch(error){json(res,400,{message:error.message});}
    return;
  }
  if(req.method==='POST'&&path==='/api/semantics/connect'){
    if(configuring||busy){json(res,409,{message:'Дождитесь завершения текущей настройки или сбора.'});return;}
    configuring=true;
    try{
      connection=await connectN8n(await bodyOf(req),connection);
      json(res,200,connectionStatus());
    }catch(error){json(res,400,{message:error.message,field:error.field});}
    finally{configuring=false;}
    return;
  }
  if(req.method==='POST'&&path==='/api/campaign/prepare'){
    if(!connection?.campaign){json(res,409,{message:'Сначала подключите воркфлоу кампании в настройках n8n.'});return;}
    if(configuring||busy){json(res,409,{message:'Дождитесь завершения текущего действия n8n.'});return;}
    busy=true;
    try{
      const input=campaignInput(await bodyOf(req,4*1024*1024));
      const result=await callWorkflow(connection.campaign,input,4*60*1000);
      json(res,200,campaignOutput(result,input));
    }catch(error){json(res,400,{message:error.message});}
    finally{busy=false;}
    return;
  }
  if (req.method==='POST' && path==='/api/semantics/jobs') {
    if(!connection){json(res,409,{message:'Сначала подключите n8n в настройках.'});return;}
    let input;
    try {input=validateJob(await bodyOf(req));} catch(error){json(res,400,{message:error.message});return;}
    if (busy||configuring) {json(res,409,{message:'Дождитесь завершения текущей настройки или сбора.'});return;}
    const job={id:randomUUID(),status:'running'};
    jobs.set(job.id,job);busy=true;
    json(res,202,{id:job.id});void run(job,input,connection);return;
  }
  if (req.method==='GET' && /^\/api\/semantics\/jobs\/[\da-f-]{36}$/.test(path)) {
    const job=jobs.get(path.split('/').pop());
    json(res,job?200:404,job??{message:'Результат недоступен. Проверьте, что локальный мост не перезапускался.'});return;
  }
  json(res,404,{message:'Страница не найдена.'});
});
server.listen(port,host,()=>{
  console.log('Ключник: '+origin);
  if(process.platform==='win32'&&process.argv.includes('--open')){
    const browser=spawn('cmd.exe',['/d','/c','start','',origin],{stdio:'ignore',windowsHide:true,detached:true});
    browser.on('error',()=>{});
    browser.unref();
  }
});
