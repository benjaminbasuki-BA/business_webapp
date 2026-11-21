import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('sales, stock, payments, roles, and reports reconcile', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'meridian-flow-'));
  const port = 33100 + Math.floor(Math.random() * 1000);
  const server = spawn(process.execPath, [resolve('server/index.js')], { cwd, env: { ...process.env, PORT: String(port), DATABASE_URL: '', ADMIN_EMAIL: 'admin@test.local', ADMIN_PASSWORD: 'AdminPass123!', CUSTOMER_EMAIL: 'buyer@test.local', CUSTOMER_PASSWORD: 'BuyerPass123!' }, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}/api`;
  let adminCookie, customerCookie;
  async function call(path, method='GET', body, cookie) {
    const r = await fetch(base+path, { method, headers: { 'Content-Type':'application/json', ...(cookie?{Cookie:cookie}:{}) }, body:body?JSON.stringify(body):undefined });
    return { status:r.status, data:await r.json(), cookie:r.headers.get('set-cookie')?.split(';')[0] };
  }
  try {
    let ready=false;
    for(let i=0;i<100;i++){if(server.exitCode!==null)throw new Error('Server exited');try{const r=await call('/login','POST',{email:'admin@test.local',password:'AdminPass123!'});if(r.status===200){adminCookie=r.cookie;ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}
    assert.ok(ready,'server started');
    const customer=await call('/login','POST',{email:'buyer@test.local',password:'BuyerPass123!'});
    assert.equal(customer.status,200);customerCookie=customer.cookie;
    assert.equal((await call('/reports','GET',null,customerCookie)).status,403);
    const products=(await call('/products','GET',null,adminCookie)).data;
    const item=products.find(p=>p.kind==='good');
    const before=item.stock_qty;
    const purchase=await call('/purchases','POST',{supplier:'Test supplier',payment_account:'2000',items:[{product_id:item.id,quantity:3,unit_cost:12.50}]},adminCookie);
    assert.equal(purchase.status,200,JSON.stringify(purchase.data));
    const order=await call('/orders','POST',{payment_method:'credit',items:[{product_id:item.id,quantity:2}]},customerCookie);
    assert.equal(order.status,200,JSON.stringify(order.data));
    assert.equal((await call('/products','GET',null,adminCookie)).data.find(p=>p.id===item.id).stock_qty,before+1);
    const detail=await call(`/orders/${order.data.id}`,'GET',null,customerCookie);
    assert.equal(detail.data.items.length,1);
    assert.equal((await call(`/orders/${order.data.id}/payments`,'POST',{amount:1,account_code:'1010'},customerCookie)).status,403);
    const paid=await call(`/orders/${order.data.id}/payments`,'POST',{amount:order.data.total_cents/100,account_code:'1010'},adminCookie);
    assert.equal(paid.status,200,JSON.stringify(paid.data));
    const expense=await call('/expenses','POST',{description:'Water bill',category:'Utilities',payment_account:'1010',account_code:'6100',amount:5.25},adminCookie);
    assert.equal(expense.status,200,JSON.stringify(expense.data));
    const income=await call('/incomes','POST',{description:'Service fee',category:'Other',deposit_account:'1000',account_code:'4100',amount:7.75},adminCookie);
    assert.equal(income.status,200,JSON.stringify(income.data));
    const print=await call(`/orders/${order.data.id}/print`,'POST',{},adminCookie);
    assert.equal(print.status,200,JSON.stringify(print.data));
    const reports=await call('/reports','GET',null,adminCookie);
    assert.equal(reports.status,200,JSON.stringify(reports.data));
    const sum=reports.data.balances.reduce((v,x)=>v+x.debit_cents-x.credit_cents,0);
    assert.equal(sum,0,'journal balances');
    assert.equal((await call(`/orders/${order.data.id}`,'GET',null,customerCookie)).data.payment_method,'credit');
  } finally {server.kill();}
});
