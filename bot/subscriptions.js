// Entrada e saída das novidades e das campanhas, sem Supabase aqui: index.js liga ao banco e
// subscriptions.test.js testa com dados falsos.
//   - sair ("parar novidades", "parar promoções") tira dos inscritos e grava na lista de saída (optouts),
//     que o envio das campanhas respeita;
//   - entrar ("quero receber novidades", opção 4) faz o contrário.
import { phoneKey } from '../assets/js/coupons.js';

export const CAMPAIGN_REPLY_DAYS = 30;

// db: addSubscriber(phone, name), removeSubscriber(phone) → true se estava inscrita, addOptout(phoneKey, phone),
//     removeOptout(phoneKey), sentCount(phoneKey, desdeIso | null) → quantas campanhas foram enviadas para a pessoa
export function createSubscriptions(db, now = () => Date.now()) {
  return {
    // Ao sair, devolve false quando a pessoa nem era inscrita nem recebeu campanha: o motor fica quieto
    // (pode ser só conversa), mas ela sai das campanhas do mesmo jeito.
    async subscribe(phone, name, on) {
      const key = phoneKey(phone);
      if (on) {
        await db.addSubscriber(phone, name);
        await db.removeOptout(key);
        return;
      }
      const was = await db.removeSubscriber(phone);
      const got = (await db.sentCount(key, null)) > 0;
      await db.addOptout(key, phone);
      return was || got;
    },
    // Recebeu campanha nos últimos 30 dias: "parar" ou "sair" sozinho vale como saída das promoções (core.js).
    async gotCampaign(phone) {
      const since = new Date(now() - CAMPAIGN_REPLY_DAYS * 864e5).toISOString();
      return (await db.sentCount(phoneKey(phone), since)) > 0;
    },
  };
}
