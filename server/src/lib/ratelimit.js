/* Limite de requisições em memória — suficiente para um processo único.
   Se um dia rodar em vários processos, trocar o Map por Redis. */

const baldes = new Map();

setInterval(() => {
  const agora = Date.now();
  for (const [k, v] of baldes) if (v.reset < agora) baldes.delete(k);
}, 60_000).unref?.();

export function limitar({ chave, max, janelaMs }) {
  const agora = Date.now();
  const atual = baldes.get(chave);
  if (!atual || atual.reset < agora) {
    baldes.set(chave, { contagem: 1, reset: agora + janelaMs });
    return { ok: true, restante: max - 1 };
  }
  atual.contagem++;
  if (atual.contagem > max) {
    return { ok: false, esperarSeg: Math.ceil((atual.reset - agora) / 1000) };
  }
  return { ok: true, restante: max - atual.contagem };
}

export const ipDe = (req) =>
  (req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || 'desconhecido').trim();

export function middlewareLimite({ nome, max, janelaMs }) {
  return (req, res, next) => {
    const r = limitar({ chave: `${nome}:${ipDe(req)}`, max, janelaMs });
    if (!r.ok) {
      res.set('Retry-After', String(r.esperarSeg));
      return res.status(429).json({ error: 'muitas_tentativas', esperarSeg: r.esperarSeg });
    }
    next();
  };
}
