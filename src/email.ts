import { CreateEmailResponseSuccess, ErrorResponse, Resend } from 'resend';

export const emailToolSchema = {
	name: 'send_email_to_customer',
	description:
		'This tool will send an email to a customer.\n\nIt takes two arguments:\n- email (str): The email of the customer.\n- subject (str): The subject of the email.\n- html (str): The content of the email body in html.',
	type: 'function',
	parameters: {
		type: 'object',
		properties: {
			email: {
				format: 'email',
				type: 'string',
			},
			subject: {
				type: 'string',
			},
			html: {
				type: 'string',
			},
		},
		required: ['email', 'subject', 'html'],
	},
};

interface EmailStatus {
	data: CreateEmailResponseSuccess | null;
	error: ErrorResponse | null;
}

export const emailToolHandler = async (env: Env, args: { email: string; subject: string; html: string }): Promise<EmailStatus> => {
	const resend = new Resend(env.RESEND_API_KEY);
	return resend.emails.send({
		from: env.RESEND_FROM_EMAIL,
		to: args.email,
		subject: args.subject,
		html: args.html,
	});
};
