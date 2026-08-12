ALTER TABLE gate_intents
	DROP CONSTRAINT IF EXISTS gate_intents_state_check;

ALTER TABLE gate_intents
	ADD CONSTRAINT gate_intents_state_check CHECK (
		state IN (
			'pending_invoice',
			'invoice_issuing',
			'invoice_issued',
			'invoice_uncertain',
			'paid',
			'authorized',
			'expired',
			'failed'
		)
	);
