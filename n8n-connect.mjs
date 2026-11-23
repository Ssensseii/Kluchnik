import { randomBytes } from 'node:crypto';
import { readFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const template = JSON.parse(await readFile(new URL('./klyuchnik-n8n.json',import.meta.url),'utf8'));
const campaignTemplate = JSON.parse(await readFile(new URL('./klyuchnik-campaign-n8n.json',import.meta.url),'utf8'));
const configPath = process.env.KLYUCHNIK_CONFIG || join(process.env.LOCALAPPDATA || join(homedir(),'.config'),'Kluchnik','n8n.json');
const loopback = new Set(['127.0.0.1','localhost','[::1]']);

function localUrl(value){
  let url;
  try {url=new URL(value);} catch {throw Error('Введите адрес n8n, например http://127.0.0.1:5678.');}
  if(!['http:','https:'].includes(url.protocol)||!loopback.has(url.hostname)||url.username||url.password||url.search||url.hash){
    throw Error('Укажите локальный HTTP(S)-адрес n8n без логина, пароля и параметров.');
  }
  return url.href.replace(/\/+$/,'');
}

export async function loadConnection(){
  if(process.env.KLYUCHNIK_WEBHOOK_TOKEN){
    return {webhook:localUrl(process.env.KLYUCHNIK_N8N_WEBHOOK||'http://127.0.0.1:5678/webhook/klyuchnik-semantics'),
      token:process.env.KLYUCHNIK_WEBHOOK_TOKEN,name:'Вебхук из настроек запуска'};
  }
  try{
    const connection=JSON.parse(await readFile(configPath,'utf8'));
    if(typeof connection.token!=='string'||!/^[\x21-\x7e]+$/.test(connection.token))throw Error('Некорректный токен вебхука.');
    const campaign=connection.campaign;
    if(campaign&&(typeof campaign.token!=='string'||/[^\x21-\x7e]/.test(campaign.token)))throw Error('Некорректный токен вебхука кампании.');
    return {...connection,webhook:localUrl(connection.webhook),...(campaign?{campaign:{...campaign,webhook:localUrl(campaign.webhook)}}:{})};
  }catch(error){
    if(error.code==='ENOENT')return null;
    throw error;
  }
}

function createApi(base,key){
  return async (path,method='GET',body)=>{
    let res;
    try{
      res=await fetch(base+'/api/v1'+path,{method,redirect:'error',signal:AbortSignal.timeout(20000),headers:{
        'X-N8N-API-KEY':key,Accept:'application/json',...(body?{'Content-Type':'application/json'}:{})
      },...(body?{body:JSON.stringify(body)}:{})});
    }catch{throw Error('n8n не ответил. Проверьте адрес и убедитесь, что n8n запущен.');}
    if(!res.ok){
      if(res.status===401||res.status===403)throw Error('n8n не принял ключ API или ключу не хватает прав для '+method+' '+path.split('?')[0]+'.');
      const error=Error('API n8n вернул HTTP '+res.status+' для '+method+' '+path.split('?')[0]+'.');
      error.status=res.status;
      throw error;
    }
    if(res.status===204)return null;
    return res.json().catch(()=>{throw Error('По указанному адресу API n8n не вернул JSON.');});
  };
}

async function findWorkflow(api,name,optional=false){
  let cursor;
  const seen=new Set(), matches=[];
  do{
    const result=await api('/workflows?limit=100'+(cursor?'&cursor='+encodeURIComponent(cursor):''));
    if(!Array.isArray(result?.data))throw Error('API n8n вернул неизвестный формат списка воркфлоу.');
    matches.push(...result.data.filter(item=>item.name===name&&!item.isArchived));
    cursor=result.nextCursor;
    if(cursor&&seen.has(cursor))throw Error('n8n повторил страницу списка воркфлоу.');
    seen.add(cursor);
  }while(cursor);
  if(matches.length>1)throw Error('В n8n несколько воркфлоу с таким именем. Переименуйте один из них.');
  if(!matches.length&&optional)return null;
  if(!matches.length)throw Error('Воркфлоу «'+name+'» не найден. Скопируйте его полное название из n8n.');
  return api('/workflows/'+encodeURIComponent(matches[0].id));
}

function literal(code,variable){
  return String(code??'').match(new RegExp('^\\s*const '+variable+'\\s*=\\s*([\'"\x60])([^\'"\x60\\r\\n]+)\\1\\s*;','m'))?.[2];
}
function extractAgent(source,folderOverride){
  if(!Array.isArray(source?.nodes))throw Error('n8n не вернул узлы воркфлоу.');
  const find=name=>source.nodes.find(node=>node.name===name);
  const wordstat=find('3. Глубокий парсинг Wordstat (BFS, порог 50)')||find('Сбор Wordstat');
  const claude=find('13. ИИ (Claude): Оценка релевантности')||find('Оценка релевантности Claude');
  const settings=find('Параметры Wordstat');
  const form=find('1. Ввод масок');
  const folderField=form?.parameters?.formFields?.values?.find(field=>field.fieldLabel?.includes('Folder ID'));
  const apiKey=literal(wordstat?.parameters?.jsCode,'apiKey');
  const folder=folderOverride||literal(settings?.parameters?.jsCode,'folderId')||folderField?.defaultValue;
  const credential=claude?.credentials?.anthropicApi;
  if(!wordstat||!claude)throw Error('Этот воркфлоу не похож на Wordstat-агента «Ключника». Выберите воркфлоу с узлами сбора Wordstat и оценки Claude.');
  if(!apiKey||apiKey.startsWith('ВСТАВЬТЕ_'))throw Error('В узле сбора не найден настроенный ключ Wordstat.');
  if(!credential?.id)throw Error('В узле оценки Claude исходного агента нужно выбрать credential Anthropic.');
  if(!folder||String(folder).startsWith('ВСТАВЬТЕ_')){
    const error=Error('В старом воркфлоу Folder ID вводится при запуске. Укажите его здесь один раз.');
    error.field='folderId';throw error;
  }
  if(!/^[a-zA-Z0-9_-]{1,128}$/.test(folder))throw Error('Проверьте Folder ID каталога Yandex Cloud.');
  return {apiKey,folder,credential};
}

async function persist(connection){
  await mkdir(dirname(configPath),{recursive:true,mode:0o700});
  const temp=configPath+'.'+randomBytes(8).toString('hex')+'.tmp';
  await writeFile(temp,JSON.stringify(connection),{mode:0o600,flag:'wx'});
  try{await rename(temp,configPath);}catch(error){
    const {unlink}=await import('node:fs/promises');
    await unlink(temp).catch(()=>{});
    throw error;
  }
}

async function provisionWorkflow(api,base,name,pathPrefix,source,configure,rollback){
  const suffix=randomBytes(8).toString('hex');
  const token=randomBytes(32).toString('hex');
  const path=pathPrefix+'-'+suffix;
  const credential=await api('/credentials','POST',{
    name:'Kluchnik · '+suffix,type:'httpHeaderAuth',data:{name:'X-Klyuchnik-Token',value:token}
  });
  const credentialId=credential?.id;
  if(!credentialId)throw Error('API n8n не вернул ID созданного доступа вебхука.');
  rollback.push(()=>api('/credentials/'+encodeURIComponent(credentialId),'DELETE'));
  const {nodes,connections,settings}=structuredClone(source);
  const trigger=nodes.find(node=>node.type==='n8n-nodes-base.webhook');
  trigger.parameters.path=path;
  delete trigger.webhookId;
  trigger.credentials={httpHeaderAuth:{id:credentialId,name:credential.name||'Kluchnik · '+suffix}};
  configure(nodes);
  const created=await api('/workflows','POST',{name,nodes,connections,settings});
  const workflowId=created?.id;
  if(!workflowId)throw Error('API n8n не вернул ID созданного воркфлоу.');
  const workflowPath='/workflows/'+encodeURIComponent(workflowId);
  rollback.push(()=>api(workflowPath,'DELETE'));
  await api(workflowPath+'/activate','POST');
  return {name,workflowId,token,webhook:base+'/webhook/'+path};
}

async function connectCampaign(api,base,name,input,previous,agent,rollback){
  if(!name)return null;
  const workflow=await findWorkflow(api,name,true);
  if(!workflow){
    if(input.createCampaign!==true)throw Error('Воркфлоу кампании «'+name+'» не найден. Проверьте название или разрешите создать его.');
    return provisionWorkflow(api,base,name,'klyuchnik-campaign',campaignTemplate,nodes=>{
      nodes.find(node=>node.name==='Подготовить объявления Claude').credentials={anthropicApi:agent.credential};
    },rollback);
  }
  const triggers=workflow.nodes?.filter(node=>node.type==='n8n-nodes-base.webhook'&&!node.disabled&&
    node.parameters?.httpMethod==='POST')??[];
  const trigger=triggers[0]?.parameters;
  const path=trigger?.path;
  if(triggers.length!==1||typeof path!=='string'||!/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(path)||
      !['headerAuth','none',undefined].includes(trigger.authentication)){
    throw Error('Воркфлоу кампании должен иметь один POST Webhook с постоянным путём и поддерживать Header Auth.');
  }
  const token=String(input.campaignToken??'').trim()||(previous?.workflowId===workflow.id?previous.token:'');
  if(trigger.authentication==='headerAuth'&&!token){
    const error=Error('Для существующего воркфлоу кампании введите значение заголовка X-Klyuchnik-Token.');
    error.field='campaignToken';
    throw error;
  }
  if(token.length>4096||/[^\x21-\x7e]/.test(token))throw Error('Проверьте значение заголовка X-Klyuchnik-Token.');
  if(!workflow.active){
    if(previous?.workflowId!==workflow.id)throw Error('Активируйте существующий воркфлоу кампании в n8n.');
    await api('/workflows/'+encodeURIComponent(workflow.id)+'/activate','POST');
  }
  return {name,workflowId:workflow.id,token:trigger.authentication==='headerAuth'?token:'',webhook:base+'/webhook/'+path};
}

export async function connectN8n(input,previous){
  const base=localUrl(String(input?.url??'').trim());
  const key=String(input?.key??'').trim(), name=String(input?.name??'').trim();
  const campaignName=String(input?.campaignName??'').trim();
  if(!key||key.length>4096||!/^[\x21-\x7e]+$/.test(key)||!name||name.length>128)throw Error('Введите API-ключ n8n и точное название воркфлоу семантики.');
  if(campaignName.length>128||campaignName===name)throw Error('Укажите отдельное название воркфлоу кампании.');
  const api=createApi(base,key);
  const source=await findWorkflow(api,name);
  const sameSource=previous?.base===base&&previous?.sourceId===source.id;
  const sourceVersion=source.versionId??source.updatedAt??null;
  const agent=extractAgent(source,String(input?.folderId??'').trim()||(sameSource?previous.folder:''));
  const rollback=[];
  try{
    let semantics;
    if(sameSource&&previous.folder===agent.folder&&previous.sourceVersion===sourceVersion&&previous.workflowId){
      const remotePath='/workflows/'+encodeURIComponent(previous.workflowId);
      try{
        const existing=await api(remotePath);
        if(!existing.active)await api(remotePath+'/activate','POST');
        semantics=previous;
      }catch(error){if(error.status!==404)throw error;}
    }
    semantics??=await provisionWorkflow(api,base,('Kluchnik · '+name+' · '+randomBytes(4).toString('hex')).slice(0,128),
      'klyuchnik-semantics',template,nodes=>{
        const params=nodes.find(node=>node.name==='Параметры Wordstat');
        params.parameters.jsCode=params.parameters.jsCode.replace(/const folderId = [^;]+;/,()=> 'const folderId = '+JSON.stringify(agent.folder)+';');
        const collector=nodes.find(node=>node.name==='Сбор Wordstat');
        collector.parameters.jsCode=collector.parameters.jsCode.replace(/const apiKey = [^;]+;/,()=> 'const apiKey = '+JSON.stringify(agent.apiKey)+';');
        nodes.find(node=>node.name==='Оценка релевантности Claude').credentials={anthropicApi:agent.credential};
      },rollback);
    const campaign=await connectCampaign(api,base,campaignName,input,previous?.base===base?previous.campaign:null,agent,rollback);
    const {workflowId,token,webhook}=semantics;
    const connection={base,name,folder:agent.folder,sourceId:source.id,sourceVersion,workflowId,token,webhook,campaign};
    await persist(connection);
    return connection;
  }catch(error){
    for(const undo of rollback.reverse())await undo().catch(()=>{});
    throw error;
  }
}
