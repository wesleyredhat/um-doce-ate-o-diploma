// npm test: Pix Copia e Cola (BR Code).
import test from 'node:test';
import assert from 'node:assert/strict';
import { pixCode, pixKey, pixKeyLabel, pixKeyType } from '../supabase/functions/_shared/pix.js';

test('exemplo do manual do BR Code (Banco Central) sai igual, com o mesmo CRC', () => {
  assert.equal(
    pixCode({ key: '123e4567-e12b-12d1-a456-426655440000', name: 'Fulano de Tal', city: 'BRASILIA' }),
    '00020126580014br.gov.bcb.pix0136123e4567-e12b-12d1-a456-4266554400005204000053039865802BR5913Fulano de Tal6008BRASILIA62070503***63041D3D',
  );
});

test('código do pedido: chave de celular com +55, valor, nome sem acento e o número do pedido', () => {
  const c = pixCode({ key: '11941776869', name: 'Um Doce Até o Diploma', city: 'São Paulo', amount: 66, txid: 'DD-K7P2' });
  assert.match(c, /^000201/);
  assert.ok(c.includes('0114+5511941776869'), 'chave de celular no formato do Pix');
  assert.ok(c.includes('540566.00'), 'valor com ponto e 2 casas');
  assert.ok(c.includes('5921Um Doce Ate o Diploma6009Sao Paulo'), 'nome e cidade sem acento');
  assert.ok(c.includes('62100506DDK7P2'), 'número do pedido, só letras e números');
  assert.match(c, /6304[0-9A-F]{4}$/);
});

test('tipo e formato da chave', () => {
  assert.equal(pixKeyType('11941776869'), 'celular', '11 dígitos que não são CPF válido');
  assert.equal(pixKeyType('529.982.247-25'), 'cpf');
  assert.equal(pixKeyType('11.222.333/0001-81'), 'cnpj');
  assert.equal(pixKeyType('Loja@Doce.com'), 'email');
  assert.equal(pixKeyType('+55 11 94177-6869'), 'celular');
  assert.equal(pixKey('(11) 94177-6869'), '+5511941776869');
  assert.equal(pixKey('5511941776869', 'celular'), '+5511941776869');
  assert.equal(pixKey('529.982.247-25'), '52998224725');
  assert.equal(pixKey('52998224725', 'celular'), '+5552998224725', 'Ajustes pode fixar o tipo');
  assert.equal(pixKey(' Loja@Doce.com '), 'loja@doce.com');
});

test('chave para ler na mensagem', () => {
  assert.equal(pixKeyLabel('11941776869'), 'celular +55 11 94177-6869');
  assert.equal(pixKeyLabel('+55 11 4177-6869', 'celular'), 'celular +55 11 4177-6869');
  assert.equal(pixKeyLabel('52998224725'), 'CPF 529.982.247-25');
  assert.equal(pixKeyLabel('11222333000181'), 'CNPJ 11.222.333/0001-81');
  assert.equal(pixKeyLabel('Loja@Doce.com'), 'e-mail loja@doce.com');
});
