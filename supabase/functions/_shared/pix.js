// Pix Copia e Cola (BR Code do Banco Central, Pix estático com valor): a cliente copia o código no WhatsApp
// e cola no app do banco em "Pix Copia e Cola", que já preenche a chave, o valor e o número do pedido.
// Formato do manual do BR Code: cada campo é ID + tamanho com 2 dígitos + valor; no fim, CRC16-CCITT.
export const PIX_TYPES = { celular: 'Celular', cpf: 'CPF', cnpj: 'CNPJ', email: 'E-mail', aleatoria: 'Chave aleatória' };

const field = (id, value) => `${id}${String(value.length).padStart(2, '0')}${value}`;
// Nome e cidade: sem acento e no limite do manual (25 e 15 letras).
const ascii = (s, max) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9 .-]/g, '').trim().slice(0, max);

function crc16(s) {
  let crc = 0xffff;
  for (let i = 0; i < s.length; i++) {
    crc ^= s.charCodeAt(i) << 8;
    for (let b = 0; b < 8; b++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

function cpfOk(d) {
  if (!/^\d{11}$/.test(d) || /^(\d)\1+$/.test(d)) return false;
  return [9, 10].every((n) => {
    const sum = [...d.slice(0, n)].reduce((s, c, i) => s + Number(c) * (n + 1 - i), 0);
    return ((sum * 10) % 11) % 10 === Number(d[n]);
  });
}

// Tipo da chave pelo formato (Ajustes pode fixar outro): 11 dígitos é CPF só se o dígito verificador bater.
export function pixKeyType(raw) {
  const v = String(raw || '').trim();
  const d = v.replace(/\D/g, '');
  if (v.includes('@')) return 'email';
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) return 'aleatoria';
  if (v.startsWith('+')) return 'celular';
  if (d.length === 14) return 'cnpj';
  if (d.length === 11 && cpfOk(d)) return 'cpf';
  return 'celular';
}

// A chave como o Pix espera: celular com +55, CPF e CNPJ só com números, e-mail e aleatória em minúsculas.
export function pixKey(raw, type = '') {
  const v = String(raw || '').trim();
  const t = type || pixKeyType(v);
  if (t === 'email' || t === 'aleatoria') return v.toLowerCase();
  const d = v.replace(/\D/g, '');
  if (t === 'celular') return `+${d.length <= 11 ? `55${d}` : d}`;
  return d;
}

// Código com valor e o número do pedido (até 25 letras e números; sem, vale "***").
export function pixCode({ key, type = '', name, city, amount = 0, txid = '' }) {
  const tx = String(txid).replace(/[^A-Za-z0-9]/g, '').slice(0, 25) || '***';
  const payload = field('00', '01')
    + field('26', field('00', 'br.gov.bcb.pix') + field('01', pixKey(key, type)))
    + field('52', '0000') + field('53', '986')
    + (Number(amount) > 0 ? field('54', Number(amount).toFixed(2)) : '')
    + field('58', 'BR') + field('59', ascii(name, 25) || 'RECEBEDOR') + field('60', ascii(city, 15) || 'SAO PAULO')
    + field('62', field('05', tx))
    + '6304';
  return payload + crc16(payload);
}

// Chave para ler na mensagem: "celular +55 11 94177-6869", "CPF 529.982.247-25", "e-mail loja@doce.com".
export function pixKeyLabel(raw, type = '') {
  const t = type || pixKeyType(raw);
  const k = pixKey(raw, t);
  if (t === 'celular') {
    const d = k.startsWith('+55') ? k.slice(3) : k.slice(1);
    return `celular +55 ${d.slice(0, 2)} ${d.slice(2, -4)}-${d.slice(-4)}`;
  }
  if (t === 'cpf') return `CPF ${k.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4')}`;
  if (t === 'cnpj') return `CNPJ ${k.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5')}`;
  return `${PIX_TYPES[t].toLowerCase()} ${k}`;
}

// Pix do pedido com os Ajustes da loja (settings.store): chave, tipo e, se preenchidos, nome e cidade de quem recebe.
// null sem chave cadastrada.
export function orderPix(store, o) {
  if (!String(store?.pix_key || '').trim()) return null;
  const type = store.pix_key_type || pixKeyType(store.pix_key);
  return {
    key: pixKey(store.pix_key, type),
    label: pixKeyLabel(store.pix_key, type),
    code: pixCode({
      key: store.pix_key, type: store.pix_key_type, name: store.pix_name || 'Um Doce Ate o Diploma', city: store.pix_city || 'Sao Paulo',
      amount: o.total, txid: o.code,
    }),
  };
}
