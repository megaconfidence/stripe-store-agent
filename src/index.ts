import { Agent, type AgentNamespace, type Connection, type ConnectionContext, routeAgentRequest } from 'agents';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { handleFunctionCall, jsonSend, parseMessage } from './utils';
import { emailToolSchema } from './email';

type Env = {
	MyAgent: AgentNamespace<MyAgent>;
	OPENAI_API_KEY: string;
	STRIPE_API_KEY: string;
	RESEND_API_KEY: string;
	RESEND_FROM_EMAIL: string;
};

interface TranscriptMsg {
	id: string;
	role: string;
	content: string;
}

interface AgentState {
	history: TranscriptMsg[];
}

export class MyAgent extends Agent<Env, AgentState> {
	// don't use hibernation, the dependencies will manually add their own handlers
	static options = { hibernate: false };
	mcpTools: any;
	mcpClient: any;
	async onStart() {
		this.setState({ history: [] });
		this.mcpClient = new Client({
			name: 'stripe',
			version: '1.0.0',
		});
		const transport = new StreamableHTTPClientTransport(new URL('https://mcp.stripe.com'), {
			requestInit: {
				headers: {
					Authorization: `Bearer ${this.env.STRIPE_API_KEY}`,
				},
			},
		});
		await this.mcpClient.connect(transport);
		const tools = await this.mcpClient.listTools();
		this.mcpTools = tools.tools
			.filter((i: any) =>
				[
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
				].includes(i.name),
			)
			.map((i: any) => {
				i.type = 'function';
				i.parameters = i.inputSchema;
				i.inputSchema = undefined as any;
				i.annotations = undefined as any;
				return i;
			});
		this.mcpTools.push(emailToolSchema);
	}
	async onConnect(connection: Connection, ctx: ConnectionContext) {
		if (ctx.request.url.includes('media-stream')) {
			let streamSid: any;
			const modelConn = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2025-06-03', [
				'realtime',
				'openai-insecure-api-key.' + this.env.OPENAI_API_KEY,
				'openai-beta.realtime-v1',
			]);

			modelConn.addEventListener('open', () => {
				jsonSend(modelConn, {
					type: 'session.update',
					session: {
						instructions:
							"You are a Stripe store sales agent. Always call the tools to respond to the customer's request, and be super concise in your responses. Start the conversation with a friendly greeting.",
						modalities: ['text', 'audio'],
						turn_detection: { type: 'server_vad' },
						// turn_detection: {
						// 	type: 'semantic_vad',
						// 	eagerness: 'low',
						// 	create_response: true,
						// 	interrupt_response: true,
						// },
						// input_audio_noise_reduction: 'near_field',
						// model: 'gpt-4o-realtime-preview-2025-06-03',
						// voice: 'ballad',
						voice: 'ash',
						input_audio_transcription: { model: 'gpt-4o-transcribe', language: 'en' },
						input_audio_format: 'g711_ulaw',
						output_audio_format: 'g711_ulaw',
						tools: this.mcpTools,
					},
				});
			});

			modelConn.addEventListener('message', (event) => {
				const msg = parseMessage(event.data as ArrayBuffer);
				if (!msg) return;

				switch (msg.type) {
					case 'error':
						throw new Error(JSON.stringify(msg.error));
					case 'conversation.item.input_audio_transcription.completed':
						this.updateHistory({ id: crypto.randomUUID(), role: 'user', content: msg.transcript });
						break;
					case 'response.audio_transcript.done':
						this.updateHistory({ id: crypto.randomUUID(), role: 'assistant', content: msg.transcript });
						break;
					case 'response.audio.delta':
						jsonSend(connection, {
							event: 'media',
							streamSid,
							media: { payload: msg.delta },
						});
						jsonSend(connection, {
							event: 'mark',
							streamSid,
						});
						break;

					case 'response.output_item.done': {
						const { item } = msg;
						if (item.type === 'function_call') {
							handleFunctionCall(item, this.mcpClient, this.mcpTools, this.env)
								.then((output) => {
									if (modelConn) {
										jsonSend(modelConn, {
											type: 'conversation.item.create',
											item: {
												type: 'function_call_output',
												call_id: item.call_id,
												output: JSON.stringify(output),
											},
										});
										jsonSend(modelConn, { type: 'response.create' });
									}
								})
								.catch((err) => {
									console.error('Error handling function call:', err);
								});
						}
						break;
					}
				}
			});

			connection.addEventListener('message', (event) => {
				const msg = parseMessage(event.data as ArrayBuffer);
				if (!msg) return;

				switch (msg.event) {
					case 'start':
						streamSid = msg.start.streamSid;
						break;
					case 'media':
						jsonSend(modelConn, {
							type: 'input_audio_buffer.append',
							audio: msg.media.payload,
						});
						break;
					case 'close':
						break;
				}
			});
		}
	}
	updateHistory(transcript: TranscriptMsg) {
		this.setState({ ...this.state, history: [...this.state.history, transcript] });
	}
	onMessage() {} // just a blank, the transport layer will add its own handlers
	onClose(connection: Connection) {
		connection.close();
	}
	async onError(_error: unknown): Promise<void> {
		console.log('Connection closed');
	}
}

export default {
	async fetch(request: Request, env: Env) {
		const url = new URL(request.url);
		const path = url.pathname;
		if (path === '/incoming-call' && request.method === 'POST') {
			const twimlResponse = `
			<?xml version="1.0" encoding="UTF-8"?>
			<Response>
					<Say>Connected</Say>
					<Connect>
							<Stream url="wss://${url.host}/agents/my-agent/123/media-stream" />
					</Connect>
			</Response>`.trim();
			return new Response(twimlResponse, {
				headers: { 'Content-Type': 'text/xml' },
			});
		}
		return (await routeAgentRequest(request, env, { cors: true })) || new Response('Not found', { status: 404 });
	},
} satisfies ExportedHandler<Env>;
