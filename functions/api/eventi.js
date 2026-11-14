// Cassetta della posta dell'ufficio 3D (Cloudflare Pages Functions + database D1).
// POST /api/eventi  -> Claude manda un segnale (serve la chiave di scrittura nell'intestazione x-chiave)
// GET  /api/eventi?dopo=ID -> l'ufficio legge i segnali nuovi (serve la chiave di lettura)
// Nei segnali ci sono solo nomi di personaggi e frasi fisse: mai testi delle richieste o contenuti dei file.
// I segnali più vecchi di 7 giorni si cancellano da soli.

const SETTE_GIORNI = 7 * 24 * 3600 * 1000;
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type, x-chiave',
  'Cache-Control': 'no-store'
};
const risposta = (dati, stato = 200) => new Response(JSON.stringify(dati), { status: stato, headers: { 'content-type': 'application/json; charset=utf-8', ...CORS } });

let pronta = false;
async function prepara(db) {
  if (pronta) return;
  await db.prepare('CREATE TABLE IF NOT EXISTS eventi (id INTEGER PRIMARY KEY AUTOINCREMENT, t INTEGER NOT NULL, sess TEXT, tipo TEXT, chi TEXT, fa TEXT, legge TEXT, scrive TEXT)').run();
  await db.prepare('CREATE INDEX IF NOT EXISTS eventi_t ON eventi(t)').run();
  pronta = true;
}
async function impronta(testo) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(testo || ''));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
const ID = /^[a-z0-9_]{1,40}$/;
const lista = v => (Array.isArray(v) ? v : []).filter(x => typeof x === 'string' && ID.test(x)).slice(0, 6);

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (!env.DB) return risposta({ errore: 'database non collegato' }, 503);
  const chiave = request.headers.get('x-chiave') || '';
  const imp = await impronta(chiave);
  await prepara(env.DB);

  if (request.method === 'POST') {
    if (imp !== env.CHIAVE_SCRITTURA_HASH) return risposta({ errore: 'chiave sbagliata' }, 401);
    let e; try { e = await request.json(); } catch { return risposta({ errore: 'formato sbagliato' }, 400); }
    const tipo = ['inizio', 'passo', 'fine'].includes(e.tipo) ? e.tipo : 'passo';
    if (!ID.test(e.chi || '')) return risposta({ errore: 'chi mancante' }, 400);
    const fa = String(e.fa || '').slice(0, 140);
    const sess = String(e.sess || '').replace(/[^a-z0-9]/gi, '').slice(0, 12);
    const ora = Date.now();
    const r = await env.DB.prepare('INSERT INTO eventi (t, sess, tipo, chi, fa, legge, scrive) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(ora, sess, tipo, e.chi, fa, JSON.stringify(lista(e.legge)), JSON.stringify(lista(e.scrive))).run();
    if (Math.random() < 0.05) await env.DB.prepare('DELETE FROM eventi WHERE t < ?').bind(ora - SETTE_GIORNI).run();
    return risposta({ ok: true, id: r.meta?.last_row_id ?? null });
  }

  if (request.method === 'GET') {
    if (imp !== env.CHIAVE_LETTURA_HASH && imp !== env.CHIAVE_SCRITTURA_HASH) return risposta({ errore: 'chiave sbagliata' }, 401);
    const dopo = Number(new URL(request.url).searchParams.get('dopo'));
    const q = Number.isFinite(dopo) && dopo > 0
      ? env.DB.prepare('SELECT id, t, sess, tipo, chi, fa, legge, scrive FROM eventi WHERE id > ? ORDER BY id LIMIT 100').bind(dopo)
      : env.DB.prepare('SELECT * FROM (SELECT id, t, sess, tipo, chi, fa, legge, scrive FROM eventi WHERE t > ? ORDER BY id DESC LIMIT 80) ORDER BY id').bind(Date.now() - 30 * 60 * 1000);
    const { results } = await q.all();
    const eventi = (results || []).map(r => ({ ...r, legge: JSON.parse(r.legge || '[]'), scrive: JSON.parse(r.scrive || '[]') }));
    return risposta({ eventi, ora: Date.now() });
  }
  return risposta({ errore: 'metodo non ammesso' }, 405);
}
