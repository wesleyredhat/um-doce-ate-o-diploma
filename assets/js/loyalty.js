// Carteirinha do Formando: cada pedido entregue vale 1 capelo; a cada LOYALTY_GOAL capelos, 1 brinde.
// c = cliente de admin_customers (delivered = pedidos entregues, rewards_given = brindes já entregues).
import { CONFIG } from './config.js';

export function loyaltyOf(c, goal = CONFIG.LOYALTY_GOAL) {
  const delivered = Number(c?.delivered) || 0;
  const earned = Math.floor(delivered / goal);
  const pending = Math.max(0, earned - (Number(c?.rewards_given) || 0));
  const stamps = delivered % goal;
  return { goal, delivered, stamps, left: goal - stamps, earned, pending };
}

// "7/10", ou "10/10 🎁" quando acabou de completar e o brinde ainda não foi entregue.
export function capelosText(l) {
  const shown = l.pending && !l.stamps ? l.goal : l.stamps;
  return `${shown}/${l.goal}${l.pending ? ' 🎁' : ''}`;
}

// Mensagens prontas para o WhatsApp do painel (a loja envia pelo próprio celular).
export function loyaltyMessage(c, l, reward = CONFIG.LOYALTY_REWARD) {
  const first = String(c.name || '').split(' ')[0];
  if (l.pending) return `Oi, ${first}! 🎉 Você completou a Carteirinha do Formando! Seu próximo pedido vem com ${reward} 💛`;
  return `Oi, ${first}! 🎓 Você já tem ${l.stamps} de ${l.goal} capelos na Carteirinha do Formando. ${l.left === 1 ? 'Falta só 1 pedido' : `Faltam só ${l.left} pedidos`} para ganhar ${reward}! Quer encomendar? 💛`;
}
