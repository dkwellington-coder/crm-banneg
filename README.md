# CRM Banneg

CRM de expansão de franquias com SDR de IA no WhatsApp. Feito para substituir o Kommo, o RD Station e o CRM anterior.

## O que ele faz

- **Funil kanban** rápido: arrastar e soltar, busca, só os meus. Cada coluna carrega 50 cards, então 10 mil leads não deixam a tela lenta.
- **Lead com tudo em um lugar**: WhatsApp, e-mails, notas e cada passo da IA e das automações na mesma linha do tempo.
- **SDRs de IA (Duda e Alice)**: respondem o lead no WhatsApp, fazem as perguntas de qualificação, dão nota (score e temperatura), oferecem horários livres do gerente e marcam a reunião sozinhas. Passam para uma pessoa quando o lead pede, reclama, quer negociar ou pergunta algo fora da base de conhecimento.
- **Janela de 24 h resolvida**: o CRM escolhe sozinho entre texto livre e modelo aprovado pela Meta.
- **Alerta de conta**: erro de pagamento, bloqueio ou token vencido da Meta aparece numa faixa vermelha em todas as telas.
- **Vários funis, você monta**: crie funis (Expansão, Revenda, Pós-venda...), renomeie, reordene, pinte e exclua etapas.
- **Automações por etapa, em uma frase**: "Quando o lead *entrar nesta etapa* / *ficar sem responder* por X min, horas ou dias, então *enviar WhatsApp*, *enviar e-mail*, *criar tarefa*, *mover para etapa* (até de outro funil), *ativar a SDR de IA* ou *pausar a IA*". Tem atalhos prontos e um botão para ligar e desligar cada uma. O funil Expansão já vem com o primeiro contato da IA, boas-vindas por e-mail, follow-up de 1, 3 e 7 dias sem resposta, nutrição, cobrança de proposta, onboarding e reativação de perdidos em 90 dias.
- **Metas**: atendimentos, reuniões, vendas e receita do mês, da equipe e de cada pessoa, com projeção e o quanto falta por dia.
- **Automações com registro**: toda automação tem nova tentativa automática, aparece na linha do tempo do lead e no registro com o erro, se falhar. Lembretes de reunião (1 dia e 1 hora antes) são automáticos.
- **E-mails automáticos**: sequência de boas-vindas com a apresentação (dia 0, 2 e 5) e de nutrição (dia 7 e 30), editáveis em Ajustes.
- **Importação** de planilha do Kommo, RD ou Excel, sem duplicar leads.
- **Painel**: leads, tempo de primeira resposta, qualificados, reuniões, vendas, desempenho de cada SDR e de cada origem.

## Rodar localmente

```bash
cp .env.example .env    # preencha DATABASE_URL e SEED_OWNER_PASSWORD
npm install
npx prisma migrate deploy
npm run db:seed
npm run dev             # http://localhost:3000
npm run worker          # em outro terminal: roda as automações
```

## Colocar no ar (TurboCloud ou qualquer VPS com Node 22)

```bash
npm ci && npx prisma migrate deploy && npm run db:seed && npm run build
pm2 start "npm start" --name crm
pm2 start "npm run worker" --name crm-worker
```

Na Vercel, troque o worker por um Cron chamando `GET /api/cron` a cada minuto com o cabeçalho `Authorization: Bearer $CRON_SECRET`.

## Ligar o WhatsApp oficial

1. No Meta for Developers, app do WhatsApp > Configuração > Webhook: URL `https://SEU_DOMINIO/api/whatsapp/webhook` e token de verificação = `WHATSAPP_VERIFY_TOKEN`.
2. Assine os campos `messages`.
3. Cadastre em **Ajustes > Modelos do WhatsApp** os modelos já aprovados (primeiro contato, follow-up, lembrete), com o mesmo nome do Meta.

## Formulários do site

```bash
curl -X POST https://SEU_DOMINIO/api/leads \
  -H "Authorization: Bearer $LEADS_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Ana","phone":"41999990000","email":"ana@x.com","city":"Curitiba","source":"site"}'
```

## Testes

```bash
npm test                                   # regras puras
TEST_DATABASE_URL=postgresql://... npm test # inclui o fluxo completo no Postgres
```
