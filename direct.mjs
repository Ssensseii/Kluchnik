import {createHash,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {mkdir,readFile,rename,writeFile,unlink} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join,dirname} from 'node:path';

const directory=process.env.KLYUCHNIK_DIRECT_HOME||join(process.env.LOCALAPPDATA||join(homedir(),'.config'),'Kluchnik','direct');
const settingsPath=join(directory,'connection.json');
const endpoint='https://api.direct.yandex.com/json/v501/';
const yesNo=value=>value?'YES':'NO';
const str=value=>typeof value==='string'?value.trim():'';
const values=value=>Array.isArray(value)?[...new Set(value.map(str).filter(Boolean))]:[...new Set(str(value).split(/[\n,;]+/).map(str).filter(Boolean))];

async function persist(path,data){
  await mkdir(dirname(path),{recursive:true,mode:0o700});
  const temp=path+'.'+randomUUID()+'.tmp';
  await writeFile(temp,JSON.stringify(data),{mode:0o600,flag:'wx'});
  try{await rename(temp,path);}catch(error){await unlink(temp).catch(()=>{});throw error;}
}
async function read(path){
  try{return JSON.parse(await readFile(path,'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw error;}
}
function dpapi(value,decrypt=false){
  if(process.platform!=='win32')return Promise.resolve(value);
  const script=decrypt
    ? '$ErrorActionPreference="Stop"; $s=ConvertTo-SecureString ([Console]::In.ReadToEnd()); [Console]::Write([Net.NetworkCredential]::new("",$s).Password)'
    : '$ErrorActionPreference="Stop"; $s=ConvertTo-SecureString ([Console]::In.ReadToEnd()) -AsPlainText -Force; [Console]::Write((ConvertFrom-SecureString $s))';
  return new Promise((resolve,reject)=>{
    const child=execFile('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],
      {windowsHide:true,timeout:10000},(error,stdout)=>error?reject(Error('Windows не смог открыть хранилище токена Директа.')):resolve(stdout.trim()));
    child.stdin.on('error',()=>{});
    child.stdin.end(value);
  });
}
export async function directStatus(){
  const connection=await read(settingsPath);
  return {available:Boolean(connection?.secret),login:connection?.login||''};
}
function credentials(input){
  const token=str(input?.token),login=str(input?.login);
  if(!/^[A-Za-z0-9._~+\/-]{12,2048}={0,2}$/.test(token))throw Error('Введите OAuth-токен Директа.');
  if(login&&!/^[A-Za-z0-9_.@-]{1,128}$/.test(login))throw Error('Проверьте логин клиента Директа.');
  return {token,login};
}

export function directClient({token,login},request=fetch){
  return async(service,method,params)=>{
    let reply,body;
    try{
      reply=await request(endpoint+service,{method:'POST',redirect:'error',signal:AbortSignal.timeout(30000),
        headers:{Authorization:'Bearer '+token,'Accept-Language':'ru','Content-Type':'application/json; charset=utf-8',...(login?{'Client-Login':login}:{})},
        body:JSON.stringify({method,params})});
      body=await reply.json();
    }catch{throw Error('Директ не подтвердил ответ на '+service+'.'+method+'.');}
    if(!reply.ok||body?.error){
      const reason=body?.error;
      const hint=[reason?.error_string,reason?.error_detail].filter(Boolean).join(' · ');
      const message='Директ отклонил '+service+'.'+method+
        (reason?.error_code?' (код '+reason.error_code+')':' (HTTP '+reply.status+')')+(hint?'. '+hint:'.');
      throw Error(message.replaceAll(token,'[токен скрыт]').slice(0,1000));
    }
    if(!body?.result)throw Error('Директ не вернул результат для '+service+'.'+method+'.');
    return body.result;
  };
}
export async function connectDirect(input,request=fetch){
  const connection=credentials(input);
  await directClient(connection,request)('campaigns','get',{SelectionCriteria:{},FieldNames:['Id','Name'],Page:{Limit:1}});
  await persist(settingsPath,{login:connection.login,secret:await dpapi(connection.token)});
  return {available:true,login:connection.login};
}
async function getDirectClient(request){
  const connection=await read(settingsPath);
  if(!connection?.secret)throw Error('Сначала подключите Яндекс Директ.');
  return directClient(credentials({login:connection.login,token:await dpapi(connection.secret,true)}),request);
}

function ids(input,label){
  return values(input).map(id=>{
    if(!/^[0-9]{1,15}$/.test(id)||!Number.isSafeInteger(Number(id)))throw Error(label+' — укажите числовые ID.');
    return Number(id);
  });
}
function amount(value,label){
  const number=Number(value);
  if(!Number.isFinite(number)||number<=0||number>1e9)throw Error(label+' — укажите положительную сумму.');
  return Math.round(number*1e6);
}
function strings(input){return {Items:input};}
const days={daily:[1,2,3,4,5,6,7],weekdays:[1,2,3,4,5]};
function hours(from,to,selected){
  if(!/^([01]\d|2[0-3]):00$/.test(from)||!/^(([01]\d|2[0-3]):00|23:59|24:00)$/.test(to)){
    throw Error('Для передачи расписания укажите начало и конец с точностью до часа.');
  }
  const start=Number(from.slice(0,2)),end=to==='23:59'?24:Number(to.slice(0,2));
  if(!selected.length||selected.some(day=>!Number.isInteger(day)||day<1||day>7)||start>=end)throw Error('Проверьте дни и часы показов.');
  const schedule=days.daily.map(day=>[day,...Array.from({length:24},(_,hour)=>selected.includes(day)&&hour>=start&&hour<end?100:0)].join(','));
  return {ConsiderWorkingWeekends:'NO',Schedule:strings(schedule)};
}
function timeTargeting(c,t){
  if(t.scheduleDays){
    const choices=t.scheduleDays==='custom'?(t.customDays??[]).map(day=>Number(day)+1):days[t.scheduleDays]??[];
    return hours(t.timeFrom,t.timeTo,choices);
  }
  const time=str(c.schedule);
  if(!time||/^каждый день, круглосуточно$/i.test(time))return undefined;
  if(/^будни, круглосуточно$/i.test(time))return hours('00:00','23:59',days.weekdays);
  const match=time.match(/^(будни|каждый день)\s+(\d\d:\d\d)[–-](\d\d:\d\d)$/i);
  if(!match)throw Error('Не удалось передать расписание. Укажите его в шаблоне кампании.');
  return hours(match[2],match[3],/^будни$/i.test(match[1])?days.weekdays:days.daily);
}
const attribution={last:'LC',first:'FCCD',lastSignificant:'LSCCD'};
const unsupportedCampaign={
  budgetIncrease:'увеличение бюджета',minWeeklyBudget:'минимальный бюджет обучения',callTracking:'коллтрекинг',
  autoRecommendations:'автоматическое применение рекомендаций',personalization:'персонализация',
  excludedText:'фразы-исключения персонализации',pinnedText:'закреплённые фразы персонализации',
  yandexDiscounts:'персональные скидки',experiments:'A/B-эксперименты',adjustments:'корректировки кампании'
};
const unsupportedGroup={
  excludedDescription:'описание исключений',audienceIds:'сегменты аудитории',excludedAudienceIds:'исключённые сегменты',
  adjustments:'корректировки группы'
};
function used(option){return Array.isArray(option)?option.length>0:option!==undefined&&option!==null&&option!=='';}
function rejectOptions(settings,options,label){
  const blocked=Object.entries(options).filter(([key])=>used(settings[key])).map(([,name])=>name);
  if(blocked.length)throw Error(label+' пока нельзя передать автоматически: '+blocked.join(', ')+'.');
}
function compileStrategy(c,t){
  if(c.period!=='week')throw Error('Для отправки сейчас нужен бюджет в неделю. Выберите этот период в черновике или шаблоне.');
  const WeeklySpendLimit=amount(c.budget,'Бюджет');
  const ceiling=t.maxBid?{BidCeiling:amount(t.maxBid,'Максимальная ставка')}:{};
  const strategy=t.strategyType||(c.strategy==='Максимум конверсий'?'conversions':'clicks');
  if(t.strategyKind==='package'||!['clicks','conversions'].includes(strategy))throw Error('Для первой отправки выберите обычную стратегию «Максимум кликов» или «Максимум конверсий».');
  if(t.payment==='conversions'||t.spendLimit||t.spendTarget)throw Error('Передача оплаты за конверсии и дополнительных ограничений расхода пока не поддерживается.');
  if(strategy==='clicks')return {BiddingStrategyType:'WB_MAXIMUM_CLICKS',WbMaximumClicks:{WeeklySpendLimit,...ceiling}};
  const goals=ids(t.goals?.length?t.goals.map(goal=>goal.id):c.goal,'Цель Метрики');
  if(goals.length!==1)throw Error('Для «Максимума конверсий» в этой версии нужна одна цель Метрики.');
  return {BiddingStrategyType:'WB_MAXIMUM_CONVERSION_RATE',WbMaximumConversionRate:{WeeklySpendLimit,GoalId:goals[0],...ceiling}};
}
function compileCampaign(draft,date){
  const c=draft.campaign,t=c?.templateSettings??{};
  if(!c||typeof c!=='object')throw Error('Нет настроек кампании.');
  rejectOptions(t,unsupportedCampaign,'Настройки кампании');
  const placements=t.placements??['search'];
  if(!Array.isArray(placements)||placements.length!==1||placements[0]!=='search')throw Error('Прямая отправка сейчас рассчитана на поисковую выдачу. Проверьте места показа в шаблоне.');
  const Name=str(draft.project),StartDate=str(t.startDate)||date,EndDate=str(t.endDate);
  if(!Name||Name.length>255)throw Error('Укажите название кампании длиной до 255 символов.');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(StartDate)||StartDate<date||EndDate&&(!/^\d{4}-\d{2}-\d{2}$/.test(EndDate)||EndDate<StartDate)){
    throw Error('Проверьте даты кампании. Дата начала должна быть не раньше сегодня.');
  }
  const TimeTargeting=timeTargeting(c,t);
  const counters=ids(t.counterIds??c.counter,'Счётчики Метрики');
  const goals=(t.goals??[]).filter(goal=>used(goal.price)).map(goal=>({
    GoalId:ids([goal.id],'Цель Метрики')[0],Value:amount(goal.price,'Ценность цели')
  }));
  const Settings=[];
  if(t.siteMonitoring)Settings.push({Option:'ENABLE_SITE_MONITORING',Value:yesNo(t.siteMonitoring==='yes')});
  if(t.priority)Settings.push({Option:'CAMPAIGN_EXACT_PHRASE_MATCHING_ENABLED',Value:yesNo(t.priority==='phrase')});
  if(t.attribution&&!attribution[t.attribution])throw Error('Эта модель атрибуции пока не сопоставлена с API Директа.');
  const negative=values(c.negative).map(word=>word.replace(/^-/,''));
  const excluded=values(t.blockedSites),ips=values(t.blockedIps);
  return {Name,StartDate,...(EndDate?{EndDate}:{}),...(t.timeZone?{TimeZone:t.timeZone}:{}),
    ...(TimeTargeting?{TimeTargeting}:{}),...(negative.length?{NegativeKeywords:strings(negative)}:{}),
    ...(excluded.length?{ExcludedSites:strings(excluded)}:{}),...(ips.length?{BlockedIps:strings(ips)}:{}),
    ...(t.email?{Notification:{EmailSettings:{Email:t.email}}}:{}),
    UnifiedCampaign:{
      BiddingStrategy:{Search:{...compileStrategy(c,t),PlacementTypes:{SearchResults:'YES',ProductGallery:'NO',SearchOrganizationList:'NO',Maps:'NO'}},
        Network:{BiddingStrategyType:'SERVING_OFF'}},
      ...(counters.length?{CounterIds:strings(counters)}:{}),...(goals.length?{PriorityGoals:strings(goals)}:{}),
      ...(Settings.length?{Settings}:{}),...(c.utm?{TrackingParams:str(c.utm).replace(/^\?/,'')}:{}),
      ...(t.attribution?{AttributionModel:attribution[t.attribution]}:{})
    }
  };
}
function compileGroup(group,organization){
  const Name=str(group?.name),t=group?.settings??{},geo=group?.geography??{};
  if(!Name||Name.length>255)throw Error('Укажите название группы длиной до 255 символов.');
  const label='Группа «'+Name+'»';
  rejectOptions(t,unsupportedGroup,label);
  if(t.scenario&&t.scenario!=='interested')throw Error(label+': сценарий для новых покупателей пока нельзя передать.');
  if(t.promotionMode==='own'||t.promotionMode==='off')throw Error(label+': передача настройки промоакции пока недоступна.');
  if(geo.mode==='map')throw Error(label+': передача зон по координатам пока недоступна.');
  if(t.autotarget==='no')throw Error(label+': для отправки поисковой кампании оставьте включённый автотаргетинг.');
  const regions=ids(geo.regionIds,'География группы '+Name);
  if(!regions.length&&str(geo.label)&&geo.label!=='Все регионы')throw Error(label+': укажите числовой код региона в проекте или шаблоне группы.');
  const keywords=values(group.keywords).filter(item=>item!=='---autotargeting');
  if(!keywords.length||keywords.length>200||keywords.some(item=>item.length>4096))throw Error(label+': требуется от 1 до 200 ключевых фраз допустимой длины.');
  const negative=values(group.negative).map(word=>word.replace(/^-/,''));
  const ads=Array.isArray(group.ads)?group.ads:[];
  if(!ads.length||ads.length>50)throw Error(label+': требуется хотя бы одно объявление.');
  const categoryMap={target:'Exact',narrow:'Narrow',wide:'Broader',related:'Accessory',alternative:'Alternative'};
  const brandMap={own:'WithAdvertiserBrand',competitors:'WithCompetitorsBrand',generic:'WithoutBrands'};
  const Categories=Object.fromEntries(Object.entries(categoryMap).map(([id,name])=>[name,yesNo(!t.excludedQueryTypes?.includes(id))]));
  const BrandOptions=Object.fromEntries(Object.entries(brandMap).map(([id,name])=>[name,yesNo(!t.excludedBrandTypes?.includes(id))]));
  if(!Object.values(Categories).includes('YES')||!Object.values(BrandOptions).includes('YES'))throw Error(label+': оставьте хотя бы одну категорию автотаргетинга и один тип упоминания брендов.');
  const BusinessId=organization?ids([organization],'Организация Яндекс Бизнеса')[0]:null;
  const SitelinkSetId=t.sitelinkMode==='own'?ids([t.sitelinkId],'Набор быстрых ссылок')[0]:null;
  const AdExtensionIds=t.calloutMode==='own'?ids(t.calloutIds,'Уточнения'):[];
  return {group:{Name,RegionIds:regions.length?regions:[0],UnifiedAdGroup:{OfferRetargeting:'NO'},
      ...(negative.length?{NegativeKeywords:strings(negative)}:{}),...(t.utm?{TrackingParams:str(t.utm).replace(/^\?/,'')}:{} )},
    keywords:[...keywords.map(Keyword=>({Keyword})),{Keyword:'---autotargeting',AutotargetingSettings:{Categories,BrandOptions}}],
    ads:ads.map(item=>{
      const title=str(item?.title),description=str(item?.description),Href=str(item?.url);
      let url;try{url=new URL(Href);}catch{}
      if(!title||title.length>56||!description||description.replace(/[!,.;:"]/g,'').length>81||description.length-description.replace(/[!,.;:"]/g,'').length>15||
        title.split(/\s+/).some(word=>word.length>22)||description.split(/\s+/).some(word=>word.length>23)){
        throw Error(label+': проверьте длину заголовка и текста объявления.');
      }
      if(!url||!['https:','http:'].includes(url.protocol)||Href.length>1024)throw Error(label+': нужна корректная посадочная ссылка.');
      return {ResponsiveAd:{Titles:[title],Texts:[description],Href,...(BusinessId?{BusinessId}:{}),
        ...(SitelinkSetId?{SitelinkSetId}:{}),...(AdExtensionIds.length?{AdExtensionIds}:{})}};
    })};
}
export function compileDirect(draft,date=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Moscow'}).format(new Date())){
  if(!Array.isArray(draft?.groups)||!draft.groups.length||draft.groups.length>500)throw Error('Для Директа добавьте от 1 до 500 групп.');
  const campaign=compileCampaign(draft,date);
  return {campaign,groups:draft.groups.map(group=>compileGroup(group,draft.campaign.templateSettings?.organization))};
}
export function previewDirect(draft){
  const plan=compileDirect(draft);
  return {name:plan.campaign.Name,startDate:plan.campaign.StartDate,groups:plan.groups.length,
    ads:plan.groups.reduce((total,row)=>total+row.ads.length,0),
    keywords:plan.groups.reduce((total,row)=>total+row.keywords.length-1,0)};
}
const journalDir=join(directory,'transfers');
const locked=new Set();
function journalPath(id){
  if(typeof id!=='string'||!/^[a-f0-9-]{36}$/i.test(id))throw Error('Некорректный ID операции.');
  return join(journalDir,id+'.json');
}
export async function directTransferStatus(id){
  const path=journalPath(id);
  const state=await read(path);
  if(locked.has(id))return state??{status:'running'};
  if(state?.status==='running')return {...state,status:'error',message:'Сервер остановился во время отправки. Проверьте уже созданные объекты в Директе перед новой попыткой.'};
  return state??{status:'missing'};
}
function addResults(result,expected){
  const rows=result.AddResults;
  if(!Array.isArray(rows)||rows.length!==expected)throw Error('Директ вернул неполный результат. Не отправляйте кампанию повторно до проверки аккаунта.');
  return rows;
}
function verifyAdd(rows,label){
  const errors=rows.flatMap(row=>row.Errors??[]).map(error=>[error.Code,error.Message,error.Details].filter(Boolean).join(' · '));
  if(errors.length||rows.some(row=>!Number.isSafeInteger(row.Id)))throw Error(label+': '+(errors.slice(0,3).join('; ')||'Директ не подтвердил ID созданного объекта.'));
}
export async function transferDirect(id,draft,request=fetch){
  const path=journalPath(id);
  if(locked.has(id))return {status:'running'};
  locked.add(id);
  try{
    const prior=await read(path);
    if(prior)return prior;
    const plan=compileDirect(draft);
    const call=await getDirectClient(request);
    const state={id,status:'running',step:'Кампания',name:plan.campaign.Name,campaignId:null,addedGroups:0,addedKeywords:0,addedAds:0,
      digest:createHash('sha256').update(JSON.stringify(plan)).digest('hex')};
    await persist(path,state);
    try{
      const campaigns=addResults(await call('campaigns','add',{Campaigns:[plan.campaign]}),1);
      if(Number.isSafeInteger(campaigns[0].Id))state.campaignId=campaigns[0].Id;
      await persist(path,state);
      verifyAdd(campaigns,'Кампания');
      for(const row of plan.groups){
        state.step='Группа «'+row.group.Name+'»';await persist(path,state);
        const groups=addResults(await call('adgroups','add',{AdGroups:[{...row.group,CampaignId:state.campaignId}]}),1);
        state.addedGroups+=groups.filter(item=>item.Id).length;await persist(path,state);
        verifyAdd(groups,state.step);
        const AdGroupId=groups[0].Id;
        state.step='Ключевые фразы · '+row.group.Name;await persist(path,state);
        const keywords=addResults(await call('keywords','add',{Keywords:row.keywords.map(item=>({...item,AdGroupId}))}),row.keywords.length);
        state.addedKeywords+=keywords.filter(item=>item.Id).length;await persist(path,state);
        verifyAdd(keywords,state.step);
        state.step='Объявления · '+row.group.Name;await persist(path,state);
        const ads=addResults(await call('ads','add',{Ads:row.ads.map(item=>({...item,AdGroupId}))}),row.ads.length);
        state.addedAds+=ads.filter(item=>item.Id).length;await persist(path,state);
        verifyAdd(ads,state.step);
      }
      state.status='done';state.step='Создан черновик';
    }catch(error){state.status='error';state.message=error.message;}
    await persist(path,state);
    return state;
  }finally{locked.delete(id);}
}
