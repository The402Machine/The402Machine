export type PaymentInvoice = { paymentHash: string; bolt11: string };
export type PaymentVerification = { settled: boolean };

export interface PaymentAdapter {
	createInvoice(input: { amountSats: number; memo: string; orderId: string }): Promise<PaymentInvoice>;
	findInvoice(input: { orderId: string; amountSats: number }): Promise<PaymentInvoice | null>;
	verifyInvoice(input: { paymentHash: string; amountSats: number }): Promise<PaymentVerification>;
}