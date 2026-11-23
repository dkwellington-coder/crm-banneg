# WhatsApp do suporte (servidor próprio)

Programa pequeno que liga os números de suporte ao CRM pelo QR code, do mesmo jeito que o WhatsApp Web.
Ele fica ligado o tempo todo num servidor e manda para o CRM tudo o que cada número envia e recebe,
inclusive o que o atendente responde pelo celular. Substitui a Uazapi para o Suporte, sem custo por número.

## Como subir na Railway (uma vez)

1. Entre em https://railway.com com a conta do GitHub e escolha o plano Hobby (US$ 5 por mês).
2. **New Project → Deploy from GitHub repo → crm-banneg**.
3. No serviço criado, em **Settings → Source**, coloque **Root Directory** = `gateway`.
4. Em **Variables**, crie `ADMIN_TOKEN` com o valor que o Claude passou (o mesmo que fica na Vercel como `SUPPORT_WA_ADMIN_TOKEN`).
5. Clique com o botão direito no serviço → **Attach Volume**, caminho **`/data`** (é onde ficam as conexões; sem ele, todo deploy pede QR code de novo).
6. Em **Settings → Networking**, clique em **Generate Domain** e mande o endereço para o Claude (vira `SUPPORT_WA_URL` na Vercel).

Depois disso, os números são conectados pelo CRM: **Suporte → Números e atendentes → Mostrar QR code**.

## O que ele responde (igual à Uazapi, para o CRM não precisar mudar)

| Chamada | Quem pode | O que faz |
| --- | --- | --- |
| `GET /health` | todos | confere se está ligado |
| `POST /instance/init` | `admintoken` | cria um número e devolve o token dele |
| `POST /instance/connect` | `token` do número | começa a conexão e devolve o QR code |
| `GET /instance/status` | `token` | conectado ou não, e o QR code atual |
| `POST /webhook` | `token` | para onde mandar as mensagens (o CRM configura sozinho) |
| `POST /send/text` | `token` | envia uma mensagem de texto |
| `GET /media?id=<mensagem>` | `token` | o arquivo da mensagem (áudio, foto, PDF, vídeo), inteiro ou em partes |

## Histórico e arquivos

- Quando um número é conectado, o WhatsApp manda o histórico; os últimos 30 dias vão para o CRM
  (mude com a variável `HISTORY_DAYS`). Para trazer o histórico de um número que já estava conectado,
  use **Ler o QR de novo para trazer o histórico** em Suporte → Números e atendentes.
- Cada arquivo é baixado na hora e fica no volume, em `/data/media`. O CRM mostra o arquivo na conversa
  e copia cada um para o Google Drive (pasta **Banneg Suporte**), quando o Drive está conectado.

Testes: `npm test`.
