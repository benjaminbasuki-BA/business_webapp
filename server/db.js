import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

try { process.loadEnvFile?.(); } catch (error) { if (error.code !== 'ENOENT') throw error; }

let db;
let chain = Promise.resolve();
const accountSeeds = [
  ['1000','Cash on hand','asset'],['1010','Bank','asset'],['1100','Accounts receivable','asset'],['1200','Inventory','asset'],
  ['2000','Accounts payable','liability'],['3000','Opening equity','equity'],['3100','Retained earnings','equity'],
  ['4000','Sales revenue','revenue'],['4100','Other income','revenue'],['5000','Cost of goods sold','expense'],['6100','Operating expenses','expense']
];
export function money(value) { return Math.round(Number(value || 0) * 100); }
export function hashPassword(password, salt = randomBytes(16).toString('hex')) { return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`; }
export function checkPassword(password, stored) { const [salt, hash] = stored.split(':'); const a = scryptSync(password, salt, 64); const b = Buffer.from(hash, 'hex'); return a.length === b.length && timingSafeEqual(a,b); }
export async function query(sql, params = []) { return db.query(sql, params); }
export async function tx(fn) {
  const previous = chain;
  let release;
  chain = new Promise(resolve => { release = resolve; });
  await previous;
  try { await query('BEGIN'); const result = await fn(); await query('COMMIT'); return result; }
  catch (e) { await query('ROLLBACK'); throw e; }
  finally { release(); }
}
export async function initDb() {
  if (process.env.DATABASE_URL) {
    if (!process.env.SESSION_SECRET || !process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD) throw new Error('Hosted PostgreSQL requires SESSION_SECRET, ADMIN_EMAIL, and ADMIN_PASSWORD.');
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect(); db = client;
  } else {
    await mkdir('.data', { recursive: true });
    db = new PGlite('.data/merchant');
  }
  const schema = await readFile(new URL('./schema.sql', import.meta.url), 'utf8');
  if (process.env.DATABASE_URL) await query(schema);
  else await db.exec(schema);
  await seed();
}
async function seed() {
  for (const [code,name,type] of accountSeeds) await query('INSERT INTO accounts(code,name,type) VALUES($1,$2,$3) ON CONFLICT(code) DO NOTHING',[code,name,type]);
  const settings = [['business_name','Meridian Supply'],['currency','USD'],['timezone',process.env.BUSINESS_TIMEZONE || 'Pacific/Honolulu'],['customer_sales_enabled','true'],['delivery_min_days','1'],['delivery_max_days','2']];
  for (const [key,value] of settings) await query('INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO NOTHING',[key,value]);
  const admin = process.env.ADMIN_EMAIL || 'admin@example.com';
  const customer = process.env.CUSTOMER_EMAIL || 'customer@example.com';
  const users = [[admin,process.env.ADMIN_PASSWORD || 'Admin123!','Alex Morgan','admin']];
  if (!process.env.DATABASE_URL) users.push([customer,process.env.CUSTOMER_PASSWORD || 'Customer123!','Jamie Rivera','customer']);
  for (const [email,password,name,role] of users) {
    await query('INSERT INTO users(email,password_hash,name,role) VALUES($1,$2,$3,$4) ON CONFLICT(email) DO NOTHING',[email,hashPassword(password),name,role]);
  }
  const count = await query('SELECT COUNT(*)::int AS n FROM products');
  const sampleImages = [['Everyday Ceramic Cup','ceramic-cup'],['Linen Table Runner','table-runner'],['Stoneware Serving Bowl','serving-bowl'],['Coastal Candle','candle'],['Canvas Market Tote','tote'],['Desk Styling Session','styling']];
  for (const [name,file] of sampleImages) await query("UPDATE products SET image_url=$1 WHERE name=$2 AND image_url LIKE 'https://images.unsplash.com/%'",[`/products/${file}.jpg`,name]);
  if (process.env.DATABASE_URL) return;
  if (count.rows[0].n) return;
  const products = [
    ['Everyday Ceramic Cup','Homeware',2800,1100,32,'/products/ceramic-cup.jpg'],
    ['Linen Table Runner','Homeware',4200,1700,18,'/products/table-runner.jpg'],
    ['Stoneware Serving Bowl','Homeware',5600,2300,14,'/products/serving-bowl.jpg'],
    ['Coastal Candle','Lifestyle',2400,900,27,'/products/candle.jpg'],
    ['Canvas Market Tote','Accessories',3400,1300,24,'/products/tote.jpg'],
    ['Desk Styling Session','Services',9500,0,0,'/products/styling.jpg']
  ];
  await tx(async () => {
    for (const [name,category,price,cost,stock,image] of products) await query('INSERT INTO products(name,category,price_cents,cost_cents,stock_qty,image_url,kind) VALUES($1,$2,$3,$4,$5,$6,$7)',[name,category,price,cost,stock,image,category === 'Services' ? 'service' : 'good']);
    const value = products.reduce((sum,p)=>sum+p[3]*p[4],0);
    await postJournal('Opening sample inventory', [['1200',value,0],['3000',0,value]],null,'opening');
  });
}
export async function postJournal(memo, lines, refId = null, refType = null) {
  const debit = lines.reduce((n,l)=>n+l[1],0), credit=lines.reduce((n,l)=>n+l[2],0);
  if (debit !== credit || debit <= 0) throw new Error('Journal entry is unbalanced');
  const entry = await query('INSERT INTO journal_entries(memo,ref_id,ref_type) VALUES($1,$2,$3) RETURNING id',[memo,refId,refType]);
  for (const [code,d,c] of lines) await query('INSERT INTO journal_lines(entry_id,account_code,debit_cents,credit_cents) VALUES($1,$2,$3,$4)',[entry.rows[0].id,code,d,c]);
  return entry.rows[0].id;
}
export async function getSettings() { const r=await query('SELECT key,value FROM settings'); return Object.fromEntries(r.rows.map(x=>[x.key,x.value])); }
