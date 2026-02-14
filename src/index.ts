import { Agent, type AgentNamespace, type Connection, type ConnectionContext, routeAgentRequest } from 'agents';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
	buildSessionConfig,
	buildTwimlResponse,
	createOpenAIConnection,
	handleFunctionCall,
	jsonSend,
	parseMessage,
	transformMcpTools,
} from './utils';

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
	static options = { hibernate: false };
	mcpTools: any;
	mcpClient: any;

	async onStart() {
		this.setState({ history: [] });
		this.mcpClient = new Client({ name: 'stripe', version: '1.0.0' });
		const transport = new StreamableHTTPClientTransport(new URL('https://mcp.stripe.com'), {
			requestInit: { headers: { Authorization: `Bearer ${this.env.STRIPE_API_KEY}` } },
		});
		await this.mcpClient.connect(transport);
		const { tools } = await this.mcpClient.listTools();
		this.mcpTools = transformMcpTools(tools);
	}

	async onConnect(connection: Connection, ctx: ConnectionContext) {
		if (!ctx.request.url.includes('media-stream')) return;

		let streamSid: any;
		const modelConn = createOpenAIConnection(this.env.OPENAI_API_KEY);

		modelConn.addEventListener('open', () => jsonSend(modelConn, buildSessionConfig(this.mcpTools)));

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
					jsonSend(connection, { event: 'media', streamSid, media: { payload: msg.delta } });
					jsonSend(connection, { event: 'mark', streamSid });
					break;

				case 'response.output_item.done':
					if (msg.item.type === 'function_call') {
						handleFunctionCall(msg.item, this.mcpClient, this.mcpTools, this.env)
							.then((output) => {
								jsonSend(modelConn, {
									type: 'conversation.item.create',
									item: { type: 'function_call_output', call_id: msg.item.call_id, output: JSON.stringify(output) },
								});
								jsonSend(modelConn, { type: 'response.create' });
							})
							.catch((err) => console.error('Error handling function call:', err));
					}
					break;
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
					jsonSend(modelConn, { type: 'input_audio_buffer.append', audio: msg.media.payload });
					break;
			}
		});
	}

	updateHistory(transcript: TranscriptMsg) {
		this.setState({ ...this.state, history: [...this.state.history, transcript] });
	}

	onMessage() {}

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
		if (url.pathname === '/incoming-call' && request.method === 'POST') {
			return new Response(buildTwimlResponse(url.host), { headers: { 'Content-Type': 'text/xml' } });
		}
		return (await routeAgentRequest(request, env, { cors: true })) || new Response('Not found', { status: 404 });
	},
} satisfies ExportedHandler<Env>;
