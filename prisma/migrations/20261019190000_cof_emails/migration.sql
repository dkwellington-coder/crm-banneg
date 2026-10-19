-- The COF e-mail and the three e-mails of "Proposta enviada", editable in Ajustes › E-mails automáticos
INSERT INTO "EmailTemplate" (id, key, name, subject, body, "sequenceDay", active, "updatedAt") VALUES
(
  'email_cof', 'cof', 'COF: Circular de Oferta, balanços e contrato',
  'COF - Circular de Oferta de Franquia {{empresa}}',
  E'Olá, {{nome}}!\n\nComo combinamos, seguem os documentos da franquia {{empresa}}:\n{{documentos}}\n\nA Circular de Oferta de Franquia (COF) reúne as informações do {{empresa}} e da franquia. Junto com ela vão os balanços e o contrato. Pela Lei de Franquias (Lei 13.966/2019), você recebe a COF pelo menos 10 dias antes de assinar o contrato ou fazer qualquer pagamento, para ler com calma e tirar todas as dúvidas.\n\nPor favor, confirme que recebeu os documentos no botão abaixo:\n\n{{link_cof}}\n\nPelo mesmo link você baixa os arquivos de novo quando quiser.\n\nQualquer dúvida, é só responder este e-mail.\n\nUm abraço,\nTime de Expansão {{empresa}}',
  NULL, true, CURRENT_TIMESTAMP
),
(
  'email_proposta_quase', 'proposta_quase_franqueado', 'Proposta: perto de ser franqueado',
  '{{nome}}, você está perto de se tornar franqueado {{empresa}}',
  E'Olá, {{nome}}!\n\nObrigado pela conversa. Agora você está a poucos passos de se tornar franqueado {{empresa}}.\n\nA Circular de Oferta de Franquia (COF), com os balanços e o contrato, chega por e-mail com o assunto COF. Leia com calma: pela Lei de Franquias, são pelo menos 10 dias entre a COF e a assinatura do contrato ou qualquer pagamento. É o tempo para tirar todas as dúvidas.\n\nEnquanto isso, vale rever o que você leva como franqueado:\n• Página de captação com o seu nome e a sua cidade\n• Cotação em mais de 52 seguradoras, já inclusa no royalty\n• IA no WhatsApp que atende quem chama pela sua página, inclusive à noite, e leva o contato para o seu CRM\n• Seguros, consórcio, saúde, energia e crédito para vender\n• As renovações dos seus clientes são suas e geram comissão todo ano\n\nNeste vídeo, o Wellington, fundador do {{empresa}}, conta por que criou a franquia:\n{{video_fundador}}\n\nQualquer dúvida sobre a COF ou o contrato, é só responder este e-mail.\n\nEquipe de Expansão {{empresa}}',
  NULL, true, CURRENT_TIMESTAMP
),
(
  'email_proposta_passos', 'proposta_primeiros_passos', 'Proposta: primeiros passos do franqueado',
  'Os primeiros passos de um franqueado {{empresa}}',
  E'Olá, {{nome}}!\n\nPara você enxergar como fica depois da assinatura, este é o caminho de quem entra para a rede {{empresa}}:\n\n1. Circular de Oferta (COF): você lê com calma, por pelo menos 10 dias.\n2. Contrato: assinado depois desse prazo, com as suas dúvidas respondidas.\n3. Treinamento: no Portal do Franqueado, com 12 módulos, e nos treinamentos ao vivo com o nosso time.\n4. Sua página de captação no ar, com o seu nome e a sua cidade, e a IA atendendo quem chama no WhatsApp.\n5. Primeiras vendas: cotação em mais de 52 seguradoras e o suporte do time {{empresa}}.\n\nVocê não precisa tirar a certificação de corretor: vende pela corretora {{empresa}}.\n\nQuer ver como um franqueado ganha dinheiro na prática? Este vídeo de 1 minuto mostra a conta:\n{{video_ganhos}}\n\nSe quiser marcar uma conversa para tirar dúvidas do contrato, é só responder.\n\nEquipe de Expansão {{empresa}}',
  NULL, true, CURRENT_TIMESTAMP
),
(
  'email_proposta_validacao', 'proposta_validacao', 'Proposta: valide com quem já é franqueado',
  'Valide o {{empresa}} com quem já é franqueado',
  E'Olá, {{nome}}!\n\nAntes de decidir, o melhor é ouvir quem já está na rede. Separei alguns materiais para você validar o {{empresa}}:\n\n• O Franklin, franqueado {{empresa}}, conta como foi o começo:\n{{video_franqueado}}\n\n• O que dizem outros franqueados:\n"O Banneg me deu confiança para empreender de verdade. Hoje tenho estrutura, produtos de qualidade e uma rede de apoio que me acompanha em cada etapa." Aldo Giorgi, Rio Preto (SP)\n"Trabalhar com o Banneg me fez enxergar novas oportunidades de negócio. A diversidade de produtos amplia muito meu alcance e fideliza meus clientes." Ronivaldo Freitas, Campinas (SP)\n\n• Eleito pelos próprios franqueados: melhor suporte (2022), royalty mais saudável (2023) e comissão mais agressiva (2024). Entre as 10 melhores microfranquias do Brasil em 2025 (Coverlab).\n\n• O Ciro Bottini gravou um vídeo sobre o {{empresa}}:\n{{video_bottini}}\n\n• Por que investir no {{empresa}}, em resumo:\n{{por_que_investir}}\n\nPela Lei de Franquias, a COF traz a lista dos franqueados da rede com os contatos: fique à vontade para ligar para quem quiser e perguntar como é.\n\nEquipe de Expansão {{empresa}}',
  NULL, true, CURRENT_TIMESTAMP
)
ON CONFLICT (key) DO NOTHING;

-- Vendas de Franquias › Proposta enviada: the COF goes on entering, then the three e-mails
INSERT INTO "AutomationRule" (id, "stageId", trigger, "delayMinutes", action, config, "runAfterLeaving", active, position)
SELECT v.id, s.id, 'enter', v.delay, v.action, v.config::jsonb, false, true, v.pos
FROM "Stage" s
CROSS JOIN (VALUES
  ('prop_cof', 0, 'cof', '{}', 3),
  ('prop_email_quase', 60, 'email', '{"templateKey":"proposta_quase_franqueado"}', 4),
  ('prop_email_passos', 2880, 'email', '{"templateKey":"proposta_primeiros_passos"}', 5),
  ('prop_email_validacao', 5760, 'email', '{"templateKey":"proposta_validacao"}', 6)
) AS v(id, delay, action, config, pos)
WHERE s."pipelineId" = 'cmv8gc1h400007ddjzxi76o1b' AND s.key = 'proposta'
ON CONFLICT (id) DO NOTHING;
