// Configuração da loja.
// Sem SUPABASE_URL/SUPABASE_ANON_KEY o sistema roda em MODO DEMO:
// dados ficam apenas no navegador (localStorage) — ótimo para testar, não para vender.
// Preencha os dois campos abaixo para ativar o modo produção (pedidos reais + login seguro).
export const CONFIG = {
  STORE_NAME: 'Um Doce Até o Diploma',
  TAGLINE: 'Doces que adoçam sua jornada',
  WHATSAPP_NUMBER: '5511999999999', // DDI + DDD + número, só dígitos
  INSTAGRAM: 'umdoceateodiploma',
  CITY: 'Entregas no campus e região',

  SUPABASE_URL: '',
  SUPABASE_ANON_KEY: '',

  // URL pública da Edge Function do bot (supabase/functions/whatsapp-bot).
  // Usada pelo painel para disparar novidades pelo WhatsApp.
  BOT_FUNCTION_URL: '',

  // Cartão fidelidade: a cada N pedidos entregues, 1 brinde.
  LOYALTY_GOAL: 10,
  LOYALTY_REWARD: '1 brigadeiro de presente',

  // Somente modo demo. Em produção o login é feito pelo Supabase Auth.
  DEMO_ADMIN: {
    email: 'admin@doce.com',
    // SHA-256 de "diploma2026"
    passwordHash: 'cddbbe5bdfef4b416c931089bfafc700909b7d9503940702bd4a24c0db3fc805',
  },
};

export const IS_DEMO = !CONFIG.SUPABASE_URL || !CONFIG.SUPABASE_ANON_KEY;
