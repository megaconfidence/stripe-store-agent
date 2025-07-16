import { emailToolHandler } from './email';

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
