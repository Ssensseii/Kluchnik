export async function listMetrikaGoals(input, request=fetch){
  const token=typeof input?.token==='string'?input.token.trim():'';
  const counterId=String(input?.counterId??'');
  if(!/^[A-Za-z0-9._~-]{12,2048}$/.test(token))throw Error('Введите OAuth-токен Яндекс Метрики.');
  if(!/^\d{1,15}$/.test(counterId))throw Error('Введите числовой ID счётчика.');
  let response;
  try {
    response=await request('https://api-metrika.yandex.net/management/v1/counter/'+counterId+'/goals',{
      headers:{Authorization:'OAuth '+token,Accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(15000)
    });
  } catch {throw Error('Метрика не ответила. Проверьте подключение и повторите запрос.');}
  if(!response.ok){
    if(response.status===401||response.status===403)throw Error('Метрика отклонила токен или нет доступа к счётчику '+counterId+'.');
    if(response.status===404)throw Error('Счётчик '+counterId+' не найден в Метрике.');
    throw Error('Метрика ответила HTTP '+response.status+'.');
  }
  const payload=await response.json().catch(()=>null);
  if(!Array.isArray(payload?.goals))throw Error('Метрика вернула неизвестный формат списка целей.');
  return payload.goals.filter(item=>item&&/^\d{1,15}$/.test(String(item.id))&&typeof item.name==='string')
    .map(item=>({id:String(item.id),counterId,name:item.name}));
}
