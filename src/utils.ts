import { emailToolHandler, emailToolSchema } from './email';

// --- Constants ---

export const ALLOWED_MCP_TOOLS = [
	'search_documentation',
	'create_customer',
	'list_customers',
	'list_products',
	'list_prices',
	'create_payment_link',
	'create_invoice',
	'list_invoices',
	'create_invoice_item',
	'finalize_invoice',
	'create_refund',
	'list_payment_intents',
];

const SESSION_INSTRUCTIONS =
	"You are a Stripe store sales agent whom users interact with via a phone call. You should alway speak English by default. Always call the tools to respond to the customer's request, and be super concise in your responses. Start the conversation with a friendly greeting.";

// --- Helpers ---

export function parseMessage(data: ArrayBuffer): any {
	try {
		return JSON.parse(data.toString());
	} catch {
		return null;
	}
}

function isOpen(ws?: WebSocket): ws is WebSocket {
	return !!ws && ws.readyState === WebSocket.OPEN;
}

export function jsonSend(ws: WebSocket | undefined, obj: unknown) {
	if (!isOpen(ws)) return;
	ws.send(JSON.stringify(obj));
}

export async function handleFunctionCall(item: { name: string; arguments: string }, mcpClient: any, mcpTools: any, env: Env) {
	console.log('Handling function call:', item);

	if (item.name === 'send_email_to_customer') {
		return await emailToolHandler(env, JSON.parse(item.arguments));
	}

	const fnDef = mcpTools.find((i: any) => i.name === item.name);
	if (!fnDef) {
		throw new Error(`No handler found for function: ${item.name}`);
	}

	let args: unknown;
	try {
		args = JSON.parse(item.arguments);
	} catch {
		return JSON.stringify({
			error: 'Invalid JSON arguments for function call.',
		});
	}

	try {
		console.log('Calling function:', fnDef.name, args);
		const result = await mcpClient.callTool({
			name: fnDef.name,
			arguments: args,
		});
		return result;
	} catch (err: any) {
		console.error('Error running function:', err);
		return JSON.stringify({
			error: `Error running function ${item.name}: ${err.message}`,
		});
	}
}

// --- Builders ---

export function transformMcpTools(tools: any[]) {
	const filtered = tools
		.filter((i: any) => ALLOWED_MCP_TOOLS.includes(i.name))
		.map((i: any) => {
			i.type = 'function';
			i.parameters = i.inputSchema;
			i.inputSchema = undefined as any;
			i.annotations = undefined as any;
			return i;
		});
	filtered.push(emailToolSchema);
	return filtered;
}

export function buildSessionConfig(mcpTools: any[]) {
	return {
		type: 'session.update',
		session: {
			instructions: SESSION_INSTRUCTIONS,
			modalities: ['text', 'audio'],
			turn_detection: { type: 'server_vad' },
			voice: 'ash',
			input_audio_transcription: { model: 'gpt-4o-transcribe', language: 'en' },
			input_audio_format: 'g711_ulaw',
			output_audio_format: 'g711_ulaw',
			tools: mcpTools,
		},
	};
}

export function createOpenAIConnection(apiKey: string) {
	return new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-realtime-mini-2025-12-15', [
		'realtime',
		'openai-insecure-api-key.' + apiKey,
		'openai-beta.realtime-v1',
	]);
}

export function buildTwimlResponse(host: string) {
	return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
		<Say>Connected</Say>
		<Connect>
				<Stream url="wss://${host}/agents/my-agent/123/media-stream" />
		</Connect>
</Response>`;
}
