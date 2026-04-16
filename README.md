# n8n WhatsApp bridge

This project is a focused n8n WhatsApp bridge.

It only keeps three responsibilities:

- WhatsApp registration via QR code
- Receive WhatsApp messages and forward them to n8n via webhook
- Accept outbound send requests from n8n and send them to WhatsApp

## Setup

1. Install dependencies

```bash
npm install
```

2. Create `.env`

```bash
cp .env_example .env
```

3. Configure the bridge

| Variable | Required | Description |
|---|---|---|
| `PORT` | No | HTTP port. Default is `3001`. |
| `WEB_PASSWORD` | No | Password for the web console. Default is `admin`. |
| `SESSION_SECRET` | No | Session secret for console login. |
| `DISABLE_LOGIN` | No | Set to `true` to disable console login. |
| `N8N_API_KEY` | No | API key for protected bridge APIs such as `POST /api/whatsapp/send` and `GET /api/whatsapp/status`. |
| `WHATSAPP_INCOMING_WEBHOOK_URL` | Yes | n8n webhook URL that receives inbound WhatsApp messages from the bridge. |
| `WHATSAPP_INCOMING_WEBHOOK_SECRET_HEADER` | No | Header name used when sending a secret to n8n. Default is `x-webhook-secret`. |
| `WHATSAPP_INCOMING_WEBHOOK_SECRET` | No | Secret value attached to inbound webhook calls sent to n8n. |
| `WHATSAPP_ALLOW_LIST` | No | Comma-separated WhatsApp numbers allowed to trigger the inbound webhook. |

4. Start the service

```bash
npm start
```

5. Open the console

[`http://localhost:3001`](http://localhost:3001)

Scan the QR code to register the WhatsApp account.

## n8n integration

This bridge talks to n8n in two directions:

1. Inbound: WhatsApp -> bridge -> n8n webhook
2. Outbound: n8n -> bridge send API -> WhatsApp

### Integration settings summary

Use these settings when wiring the project to n8n:

| Purpose | Where to set it | Value |
|---|---|---|
| Inbound webhook URL | `.env` | `WHATSAPP_INCOMING_WEBHOOK_URL=https://<your-n8n>/webhook/<path>` |
| Inbound webhook secret header name | `.env` | `WHATSAPP_INCOMING_WEBHOOK_SECRET_HEADER=x-webhook-secret` |
| Inbound webhook secret value | `.env` | `WHATSAPP_INCOMING_WEBHOOK_SECRET=<shared-secret>` |
| Outbound bridge auth key | `.env` | `N8N_API_KEY=<shared-api-key>` |
| Outbound send endpoint | n8n `HTTP Request` node | `POST http://<bridge-host>:3001/api/whatsapp/send` |
| Bridge status endpoint | n8n `HTTP Request` node | `GET http://<bridge-host>:3001/api/whatsapp/status` |
| Bridge health endpoint | browser / monitoring / n8n | `GET http://<bridge-host>:3001/api/health` |

## Inbound webhook

This is the webhook the bridge calls when a new WhatsApp message is received.

### Required `.env` setting

```env
WHATSAPP_INCOMING_WEBHOOK_URL=https://your-n8n-host/webhook/whatsapp-incoming
```

### Optional webhook auth settings

If you want the bridge to send a secret header to n8n:

```env
WHATSAPP_INCOMING_WEBHOOK_SECRET_HEADER=x-webhook-secret
WHATSAPP_INCOMING_WEBHOOK_SECRET=your-shared-secret
```

When these are set, the bridge will call n8n with:

- Method: `POST`
- Header: `Content-Type: application/json`
- Header: `<WHATSAPP_INCOMING_WEBHOOK_SECRET_HEADER>: <WHATSAPP_INCOMING_WEBHOOK_SECRET>`

Example:

```http
POST /webhook/whatsapp-incoming
Content-Type: application/json
x-webhook-secret: your-shared-secret
```

### Inbound webhook payload

Example text message payload:

```json
{
  "channel": "whatsapp",
  "sender": "85291234567",
  "remoteJid": "85291234567@s.whatsapp.net",
  "messageId": "ABCD1234",
  "timestamp": 1710000000,
  "text": "hello",
  "hasImage": false,
  "image": null
}
```

Example image message payload:

```json
{
  "channel": "whatsapp",
  "sender": "85291234567",
  "remoteJid": "85291234567@s.whatsapp.net",
  "messageId": "ABCD1234",
  "timestamp": 1710000000,
  "text": "look at this",
  "hasImage": true,
  "image": {
    "mimeType": "image/jpeg",
    "data": "<base64>"
  }
}
```

### Inbound webhook field reference

| Field | Type | Description |
|---|---|---|
| `channel` | string | Always `whatsapp`. |
| `sender` | string | WhatsApp sender number without `@s.whatsapp.net`. |
| `remoteJid` | string | Full WhatsApp JID. |
| `messageId` | string or `null` | WhatsApp message ID. |
| `timestamp` | number | WhatsApp timestamp. |
| `text` | string | Message text or image caption. |
| `hasImage` | boolean | Whether the message includes an image. |
| `image` | object or `null` | Base64 image payload when present. |

### Suggested n8n inbound Webhook node

- Method: `POST`
- Path: `whatsapp-incoming`
- Response mode: your choice
- Authentication: none, or verify the secret header inside the workflow

Suggested first step inside n8n:

- Check header `x-webhook-secret` or your custom header value against the shared secret

## Outbound send API

This is the API n8n calls when it wants to send a message back to WhatsApp.

### Endpoint

- `POST /api/whatsapp/send`

Example full URL:

```text
http://localhost:3001/api/whatsapp/send
```

### Authentication

If `N8N_API_KEY` is set in `.env`, n8n must include one of these headers:

- `Authorization: Bearer <N8N_API_KEY>`
- `x-api-key: <N8N_API_KEY>`

Example `.env`:

```env
N8N_API_KEY=my-bridge-api-key
```

Example request headers:

```http
Content-Type: application/json
Authorization: Bearer my-bridge-api-key
```

### Outbound send request body

Text message example:

```json
{
  "to": "85291234567",
  "text": "Hello from n8n"
}
```

Text message using full JID:

```json
{
  "to": "85291234567@s.whatsapp.net",
  "text": "Hello from n8n"
}
```

Image message example:

```json
{
  "to": "85291234567",
  "text": "Here is the image",
  "image": {
    "mimeType": "image/jpeg",
    "data": "<base64>",
    "caption": "optional caption"
  }
}
```

### Outbound send response

Success example:

```json
{
  "ok": true,
  "to": "85291234567@s.whatsapp.net",
  "hasText": true,
  "hasImage": false
}
```

Error example:

```json
{
  "ok": false,
  "error": "WhatsApp is not connected."
}
```

### Outbound send field reference

| Field | Required | Description |
|---|---|---|
| `to` | Yes | Recipient phone number or full WhatsApp JID. |
| `text` | No | Text to send. |
| `image.mimeType` | No | MIME type for image sending. |
| `image.data` | No | Base64 image data. |
| `image.caption` | No | Optional caption for the image. |

Rule:

- At least one of `text` or `image` must be provided

## Status and health APIs

### `GET /api/health`

Use this for a simple availability check.

Example response:

```json
{
  "ok": true,
  "status": "up",
  "whatsappStatus": "connected",
  "incomingWebhookConfigured": true
}
```

### `GET /api/whatsapp/status`

Use this when n8n or another system wants the bridge's WhatsApp state.

If `N8N_API_KEY` is set, include:

- `Authorization: Bearer <N8N_API_KEY>`
- or `x-api-key: <N8N_API_KEY>`

Example response:

```json
{
  "ok": true,
  "status": "connected",
  "qrAvailable": false
}
```

## n8n HTTP Request node examples

### Example 1: send reply text

- Method: `POST`
- URL: `http://<bridge-host>:3001/api/whatsapp/send`
- Send Headers:
- `Authorization: Bearer <N8N_API_KEY>`
- `Content-Type: application/json`
- Send Body: `JSON`

```json
{
  "to": "{{$json.sender}}",
  "text": "{{$json.reply}}"
}
```

### Example 2: send image

- Method: `POST`
- URL: `http://<bridge-host>:3001/api/whatsapp/send`
- Send Headers:
- `Authorization: Bearer <N8N_API_KEY>`
- `Content-Type: application/json`
- Send Body: `JSON`

```json
{
  "to": "{{$json.sender}}",
  "text": "Generated image",
  "image": {
    "mimeType": "image/png",
    "data": "{{$json.imageBase64}}",
    "caption": "Generated by n8n"
  }
}
```

### Example 3: poll bridge status

- Method: `GET`
- URL: `http://<bridge-host>:3001/api/whatsapp/status`
- Send Headers:
- `Authorization: Bearer <N8N_API_KEY>`

## Suggested n8n flow

1. Create a `Webhook` node to receive inbound WhatsApp messages.
2. Set its URL into `WHATSAPP_INCOMING_WEBHOOK_URL`.
3. Optionally validate the shared secret header.
4. Process the incoming payload in n8n.
5. Create an `HTTP Request` node that calls `POST /api/whatsapp/send`.
6. Map `sender` from the inbound payload to the outbound `to` field.

## Notes

- QR registration and connection reset are managed from the web console.
- Session files are stored in `auth_session/`.
- Audit logs are written under `log/`.
