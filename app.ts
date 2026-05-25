import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

type TransactionStatus = 'CREATED' | 'PENDING' | 'POSTED' | 'CANCELED';
type EntryDirection = 'DEBIT' | 'CREDIT';
type NormalSide = 'DEBIT' | 'CREDIT';
type AccountStatus = 'ACTIVE' | 'INACTIVE';

type AccountRow = {
	id: number;
	code: string;
	name: string;
	normal_side: NormalSide;
	status: AccountStatus;
	created_at: string;
	updated_at: string;
};

type BalanceRow = {
	account_id: number;
	pending_debit_total: number;
	pending_credit_total: number;
	pending_balance: number;
	posted_debit_total: number;
	posted_credit_total: number;
	posted_balance: number;
	updated_at: string;
};

type TransactionRow = {
	id: number;
	description: string | null;
	reference: string | null;
	status: TransactionStatus;
	created_at: string;
	updated_at: string;
};

type EntryRow = {
	id: number;
	transaction_id: number;
	account_id: number;
	direction: EntryDirection;
	amount: number;
	created_at: string;
};

type EntryInput = {
	accountId: number;
	direction: EntryDirection;
	amount: number;
};

type AccountInput = {
	code: string;
	name: string;
	normalSide: NormalSide;
	status?: AccountStatus;
};

type AccountPatchInput = Partial<AccountInput>;

type TransactionInput = {
	description?: string | null;
	reference?: string | null;
	status?: TransactionStatus;
	entries: unknown[];
};

type TransactionPatchInput = {
	description?: string | null;
	reference?: string | null;
	status?: TransactionStatus;
	entries?: unknown[];
};

type BalanceSnapshot = {
	accountId: number;
	pending: {
		debitTotal: number;
		creditTotal: number;
		balance: number;
	};
	posted: {
		debitTotal: number;
		creditTotal: number;
		balance: number;
	};
	updatedAt: string;
};

const TRANSACTION_STATUSES: TransactionStatus[] = ['CREATED', 'PENDING', 'POSTED', 'CANCELED'];
const MUTABLE_TRANSACTION_STATUSES: TransactionStatus[] = ['CREATED', 'PENDING'];
const ENTRY_DIRECTIONS: EntryDirection[] = ['DEBIT', 'CREDIT'];
const NORMAL_SIDES: NormalSide[] = ['DEBIT', 'CREDIT'];
const ACCOUNT_STATUSES: AccountStatus[] = ['ACTIVE', 'INACTIVE'];
const ACCOUNT_TRANSITIONS: Record<TransactionStatus, TransactionStatus[]> = {
	CREATED: ['CREATED', 'PENDING', 'POSTED', 'CANCELED'],
	PENDING: ['PENDING', 'POSTED', 'CANCELED'],
	POSTED: [],
	CANCELED: [],
};
const EPSILON = 0.000001;
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATABASE_PATH = join(__dirname, 'ledger.sqlite');
const PORT = Number.parseInt(process.env.PORT ?? '3000', 10);

class HttpError extends Error {
	statusCode: number;
	details?: unknown;

	constructor(statusCode: number, message: string, details?: unknown) {
		super(message);
		this.statusCode = statusCode;
		this.details = details;
	}
}

const db = new DatabaseSync(DATABASE_PATH);
initializeDatabase();

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
	void handleRequest(req, res);
});

const isMainModule = process.argv[1] ? resolve(process.argv[1]) === __filename : false;

if (isMainModule) {
	server.listen(PORT, () => {
		console.log(`Ledger service listening on http://localhost:${PORT}`);
	});
}

export { db, server };

function initializeDatabase(): void {
	db.exec(`
		PRAGMA journal_mode = WAL;
		PRAGMA foreign_keys = ON;
		PRAGMA synchronous = NORMAL;

		CREATE TABLE IF NOT EXISTS accounts (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			code TEXT NOT NULL UNIQUE,
			name TEXT NOT NULL,
			normal_side TEXT NOT NULL CHECK (normal_side IN ('DEBIT', 'CREDIT')),
			status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
			created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
			updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
		);

		CREATE TABLE IF NOT EXISTS balances (
			account_id INTEGER PRIMARY KEY,
			pending_debit_total REAL NOT NULL DEFAULT 0,
			pending_credit_total REAL NOT NULL DEFAULT 0,
			pending_balance REAL NOT NULL DEFAULT 0,
			posted_debit_total REAL NOT NULL DEFAULT 0,
			posted_credit_total REAL NOT NULL DEFAULT 0,
			posted_balance REAL NOT NULL DEFAULT 0,
			updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
			FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
		);

		CREATE TABLE IF NOT EXISTS transactions (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			description TEXT,
			reference TEXT,
			status TEXT NOT NULL CHECK (status IN ('CREATED', 'PENDING', 'POSTED', 'CANCELED')),
			created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
			updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
		);

		CREATE TABLE IF NOT EXISTS entries (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			transaction_id INTEGER NOT NULL,
			account_id INTEGER NOT NULL,
			direction TEXT NOT NULL CHECK (direction IN ('DEBIT', 'CREDIT')),
			amount REAL NOT NULL CHECK (amount > 0),
			created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
			FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE,
			FOREIGN KEY (account_id) REFERENCES accounts(id)
		);

		CREATE INDEX IF NOT EXISTS idx_entries_transaction_id ON entries(transaction_id);
		CREATE INDEX IF NOT EXISTS idx_entries_account_id ON entries(account_id);
		CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status);
	`);
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
	try {
		const method = req.method ?? 'GET';
		const parsedUrl = new URL(req.url ?? '/', 'http://localhost');
		const pathname = normalizePath(parsedUrl.pathname);
		const segments = pathname.split('/').filter(Boolean);

		if (pathname === '/account' && method === 'GET') {
			return sendJson(res, 200, { accounts: listAccounts() });
		}

		if (pathname === '/account' && method === 'POST') {
			const payload = validateAccountInput(await readJsonBody(req));
			const account = createAccount(payload);
			return sendJson(res, 201, account);
		}

		if (segments[0] === 'account' && segments.length === 2 && method === 'GET') {
			return sendJson(res, 200, getAccountResponse(parseId(segments[1], 'accountId')));
		}

		if (segments[0] === 'account' && segments.length === 2 && method === 'PATCH') {
			const payload = validateAccountPatchInput(await readJsonBody(req));
			const account = updateAccount(parseId(segments[1], 'accountId'), payload);
			return sendJson(res, 200, account);
		}

		if (segments[0] === 'account' && segments.length === 2 && method === 'DELETE') {
			deleteAccount(parseId(segments[1], 'accountId'));
			return sendNoContent(res);
		}

		if (segments[0] === 'account' && segments.length === 3 && segments[2] === 'balance' && method === 'GET') {
			return sendJson(res, 200, getBalanceSnapshot(parseId(segments[1], 'accountId')));
		}

		if (pathname === '/transaction' && method === 'GET') {
			return sendJson(res, 200, { transactions: listTransactions() });
		}

		if (pathname === '/transaction' && method === 'POST') {
			const payload = validateTransactionInput(await readJsonBody(req));
			const response = createTransaction(payload);
			return sendJson(res, 201, response);
		}

		if (segments[0] === 'transaction' && segments.length === 2 && method === 'GET') {
			return sendJson(res, 200, getTransactionResponse(parseId(segments[1], 'transactionId')));
		}

		if (segments[0] === 'transaction' && segments.length === 2 && method === 'PATCH') {
			const payload = validateTransactionPatchInput(await readJsonBody(req));
			const response = updateTransaction(parseId(segments[1], 'transactionId'), payload);
			return sendJson(res, 200, response);
		}

		if (segments[0] === 'transaction' && segments.length === 2 && method === 'DELETE') {
			deleteTransaction(parseId(segments[1], 'transactionId'));
			return sendNoContent(res);
		}

		throw new HttpError(404, 'Route not found');
	} catch (error) {
		handleError(res, error);
	}
}

function listAccounts(): ReturnType<typeof serializeAccount>[] {
	const rows = db.prepare('SELECT * FROM accounts ORDER BY id ASC').all() as AccountRow[];
	return rows.map(serializeAccount);
}

function getAccountResponse(accountId: number): ReturnType<typeof serializeAccount> {
	return serializeAccount(getAccountById(accountId));
}

function createAccount(input: AccountInput): ReturnType<typeof serializeAccount> {
	const statement = db.prepare(`
		INSERT INTO accounts (code, name, normal_side, status)
		VALUES (?, ?, ?, ?)
	`);

	try {
		const result = statement.run(input.code, input.name, input.normalSide, input.status ?? 'ACTIVE');
		const accountId = Number(result.lastInsertRowid);
		ensureBalanceRow(accountId);
		return getAccountResponse(accountId);
	} catch (error) {
		throw wrapSqliteError(error, 'Account code must be unique');
	}
}

function updateAccount(accountId: number, input: AccountPatchInput): ReturnType<typeof serializeAccount> {
	const existing = getAccountById(accountId);
	const next = {
		code: input.code ?? existing.code,
		name: input.name ?? existing.name,
		normalSide: input.normalSide ?? existing.normal_side,
		status: input.status ?? existing.status,
	};

	try {
		db.prepare(`
			UPDATE accounts
			SET code = ?,
					name = ?,
					normal_side = ?,
					status = ?,
					updated_at = CURRENT_TIMESTAMP
			WHERE id = ?
		`).run(next.code, next.name, next.normalSide, next.status, accountId);
	} catch (error) {
		throw wrapSqliteError(error, 'Account code must be unique');
	}

	recomputeBalancesForAccounts([accountId]);
	return getAccountResponse(accountId);
}

function deleteAccount(accountId: number): void {
	getAccountById(accountId);
	const usage = db.prepare('SELECT 1 AS used FROM entries WHERE account_id = ? LIMIT 1').get(accountId) as { used: number } | undefined;

	if (usage) {
		throw new HttpError(409, 'Cannot delete an account that is already referenced by entries');
	}

	db.prepare('DELETE FROM accounts WHERE id = ?').run(accountId);
}

function listTransactions(): ReturnType<typeof serializeTransaction>[] {
	const transactions = db.prepare('SELECT * FROM transactions ORDER BY id ASC').all() as TransactionRow[];
	const entriesByTransactionId = getEntriesByTransactionIds(transactions.map((transaction) => transaction.id));
	return transactions.map((transaction) => serializeTransaction(transaction, entriesByTransactionId.get(transaction.id) ?? []));
}

function getTransactionResponse(transactionId: number): ReturnType<typeof serializeTransaction> {
	const transaction = getTransactionById(transactionId);
	const entries = getEntriesForTransaction(transactionId);
	return serializeTransaction(transaction, entries);
}

function createTransaction(input: TransactionInput): {
	transaction: ReturnType<typeof serializeTransaction>;
	balances: BalanceSnapshot[];
} {
	const status = input.status ?? 'CREATED';

	if (status === 'CANCELED') {
		throw new HttpError(400, 'New transactions cannot start as CANCELED');
	}

	const normalizedEntries = validateEntries(input.entries);
	const affectedAccountIds = uniqueNumbers(normalizedEntries.map((entry) => entry.accountId));
	ensureAccountsExist(affectedAccountIds);

	return withTransaction(() => {
		const insertResult = db.prepare(`
			INSERT INTO transactions (description, reference, status)
			VALUES (?, ?, ?)
		`).run(nullableText(input.description), nullableText(input.reference), status);
		const transactionId = Number(insertResult.lastInsertRowid);

		insertEntries(transactionId, normalizedEntries);

		if (status === 'PENDING' || status === 'POSTED') {
			recomputeBalancesForAccounts(affectedAccountIds);
		}

		return {
			transaction: getTransactionResponse(transactionId),
			balances: getBalanceSnapshots(affectedAccountIds),
		};
	});
}

function updateTransaction(transactionId: number, input: TransactionPatchInput): {
	transaction: ReturnType<typeof serializeTransaction>;
	balances: BalanceSnapshot[];
} {
	const existing = getTransactionById(transactionId);

	if (!MUTABLE_TRANSACTION_STATUSES.includes(existing.status)) {
		throw new HttpError(409, `Cannot update a transaction in status ${existing.status}`);
	}

	const existingEntries = getEntriesForTransaction(transactionId);
	const nextStatus = input.status ?? existing.status;
	assertAllowedTransition(existing.status, nextStatus);

	const nextEntries = input.entries ? validateEntries(input.entries) : existingEntries.map((entry) => ({
		accountId: entry.account_id,
		direction: entry.direction,
		amount: entry.amount,
	}));

	const oldAccountIds = uniqueNumbers(existingEntries.map((entry) => entry.account_id));
	const newAccountIds = uniqueNumbers(nextEntries.map((entry) => entry.accountId));
	const affectedAccountIds = uniqueNumbers([...oldAccountIds, ...newAccountIds]);
	ensureAccountsExist(newAccountIds);

	return withTransaction(() => {
		db.prepare(`
			UPDATE transactions
			SET description = ?,
					reference = ?,
					status = ?,
					updated_at = CURRENT_TIMESTAMP
			WHERE id = ?
		`).run(
			input.description === undefined ? existing.description : nullableText(input.description),
			input.reference === undefined ? existing.reference : nullableText(input.reference),
			nextStatus,
			transactionId,
		);

		if (input.entries) {
			db.prepare('DELETE FROM entries WHERE transaction_id = ?').run(transactionId);
			insertEntries(transactionId, nextEntries);
		}

		if (shouldRecomputeBalances(existing.status, nextStatus)) {
			recomputeBalancesForAccounts(affectedAccountIds);
		} else if (existing.status === 'PENDING' && nextStatus === 'PENDING' && input.entries) {
			recomputeBalancesForAccounts(affectedAccountIds);
		}

		return {
			transaction: getTransactionResponse(transactionId),
			balances: getBalanceSnapshots(affectedAccountIds),
		};
	});
}

function deleteTransaction(transactionId: number): void {
	const existing = getTransactionById(transactionId);

	if (existing.status === 'POSTED') {
		throw new HttpError(409, 'Cannot delete a POSTED transaction');
	}

	const entries = getEntriesForTransaction(transactionId);
	const affectedAccountIds = uniqueNumbers(entries.map((entry) => entry.account_id));

	withTransaction(() => {
		db.prepare('DELETE FROM transactions WHERE id = ?').run(transactionId);

		if (existing.status === 'PENDING') {
			recomputeBalancesForAccounts(affectedAccountIds);
		}
	});
}

function getBalanceSnapshot(accountId: number): BalanceSnapshot {
	getAccountById(accountId);
	ensureBalanceRow(accountId);

	const row = db.prepare('SELECT * FROM balances WHERE account_id = ?').get(accountId) as BalanceRow | undefined;
	if (!row) {
		throw new HttpError(404, 'Balance not found');
	}

	return serializeBalance(row);
}

function getBalanceSnapshots(accountIds: number[]): BalanceSnapshot[] {
	const uniqueAccountIds = uniqueNumbers(accountIds);
	if (uniqueAccountIds.length === 0) {
		return [];
	}

	uniqueAccountIds.forEach((accountId) => ensureBalanceRow(accountId));
	const placeholders = buildPlaceholders(uniqueAccountIds.length);
	const rows = db.prepare(`
		SELECT *
		FROM balances
		WHERE account_id IN (${placeholders})
		ORDER BY account_id ASC
	`).all(...uniqueAccountIds) as BalanceRow[];

	return rows.map(serializeBalance);
}

function recomputeBalancesForAccounts(accountIds: number[]): void {
	const uniqueAccountIds = uniqueNumbers(accountIds);
	if (uniqueAccountIds.length === 0) {
		return;
	}

	const placeholders = buildPlaceholders(uniqueAccountIds.length);
	const rows = db.prepare(`
		SELECT
			a.id AS account_id,
			a.normal_side,
			COALESCE(SUM(CASE WHEN t.status = 'PENDING' AND e.direction = 'DEBIT' THEN e.amount END), 0) AS pending_debit_total,
			COALESCE(SUM(CASE WHEN t.status = 'PENDING' AND e.direction = 'CREDIT' THEN e.amount END), 0) AS pending_credit_total,
			COALESCE(SUM(CASE WHEN t.status = 'POSTED' AND e.direction = 'DEBIT' THEN e.amount END), 0) AS posted_debit_total,
			COALESCE(SUM(CASE WHEN t.status = 'POSTED' AND e.direction = 'CREDIT' THEN e.amount END), 0) AS posted_credit_total
		FROM accounts a
		LEFT JOIN entries e ON e.account_id = a.id
		LEFT JOIN transactions t ON t.id = e.transaction_id
		WHERE a.id IN (${placeholders})
		GROUP BY a.id, a.normal_side
		ORDER BY a.id ASC
	`).all(...uniqueAccountIds) as Array<{
		account_id: number;
		normal_side: NormalSide;
		pending_debit_total: number;
		pending_credit_total: number;
		posted_debit_total: number;
		posted_credit_total: number;
	}>;

	const upsert = db.prepare(`
		INSERT INTO balances (
			account_id,
			pending_debit_total,
			pending_credit_total,
			pending_balance,
			posted_debit_total,
			posted_credit_total,
			posted_balance,
			updated_at
		)
		VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
		ON CONFLICT(account_id) DO UPDATE SET
			pending_debit_total = excluded.pending_debit_total,
			pending_credit_total = excluded.pending_credit_total,
			pending_balance = excluded.pending_balance,
			posted_debit_total = excluded.posted_debit_total,
			posted_credit_total = excluded.posted_credit_total,
			posted_balance = excluded.posted_balance,
			updated_at = CURRENT_TIMESTAMP
	`);

	for (const row of rows) {
		const pendingBalance = computeBalance(row.normal_side, row.pending_debit_total, row.pending_credit_total);
		const postedBalance = computeBalance(row.normal_side, row.posted_debit_total, row.posted_credit_total);

		upsert.run(
			row.account_id,
			row.pending_debit_total,
			row.pending_credit_total,
			pendingBalance,
			row.posted_debit_total,
			row.posted_credit_total,
			postedBalance,
		);
	}
}

function getAccountById(accountId: number): AccountRow {
	const row = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId) as AccountRow | undefined;
	if (!row) {
		throw new HttpError(404, 'Account not found');
	}
	return row;
}

function getTransactionById(transactionId: number): TransactionRow {
	const row = db.prepare('SELECT * FROM transactions WHERE id = ?').get(transactionId) as TransactionRow | undefined;
	if (!row) {
		throw new HttpError(404, 'Transaction not found');
	}
	return row;
}

function getEntriesForTransaction(transactionId: number): EntryRow[] {
	return db.prepare(`
		SELECT *
		FROM entries
		WHERE transaction_id = ?
		ORDER BY id ASC
	`).all(transactionId) as EntryRow[];
}

function getEntriesByTransactionIds(transactionIds: number[]): Map<number, EntryRow[]> {
	const uniqueTransactionIds = uniqueNumbers(transactionIds);
	const entriesByTransactionId = new Map<number, EntryRow[]>();

	if (uniqueTransactionIds.length === 0) {
		return entriesByTransactionId;
	}

	const placeholders = buildPlaceholders(uniqueTransactionIds.length);
	const rows = db.prepare(`
		SELECT *
		FROM entries
		WHERE transaction_id IN (${placeholders})
		ORDER BY transaction_id ASC, id ASC
	`).all(...uniqueTransactionIds) as EntryRow[];

	for (const row of rows) {
		const existing = entriesByTransactionId.get(row.transaction_id) ?? [];
		existing.push(row);
		entriesByTransactionId.set(row.transaction_id, existing);
	}

	return entriesByTransactionId;
}

function insertEntries(transactionId: number, entries: EntryInput[]): void {
	const statement = db.prepare(`
		INSERT INTO entries (transaction_id, account_id, direction, amount)
		VALUES (?, ?, ?, ?)
	`);

	for (const entry of entries) {
		statement.run(transactionId, entry.accountId, entry.direction, entry.amount);
	}
}

function ensureBalanceRow(accountId: number): void {
	db.prepare(`
		INSERT INTO balances (account_id)
		VALUES (?)
		ON CONFLICT(account_id) DO NOTHING
	`).run(accountId);
}

function ensureAccountsExist(accountIds: number[]): void {
	const uniqueAccountIds = uniqueNumbers(accountIds);
	if (uniqueAccountIds.length === 0) {
		return;
	}

	const placeholders = buildPlaceholders(uniqueAccountIds.length);
	const rows = db.prepare(`
		SELECT id
		FROM accounts
		WHERE id IN (${placeholders})
	`).all(...uniqueAccountIds) as Array<{ id: number }>;
	const existingIds = new Set(rows.map((row) => row.id));
	const missingIds = uniqueAccountIds.filter((accountId) => !existingIds.has(accountId));

	if (missingIds.length > 0) {
		throw new HttpError(400, 'One or more entry accounts do not exist', { missingAccountIds: missingIds });
	}
}

function validateAccountInput(payload: unknown): AccountInput {
	const body = expectObject(payload, 'Account payload must be an object');
	const code = expectNonEmptyString(body.code, 'Account code is required');
	const name = expectNonEmptyString(body.name, 'Account name is required');
	const normalSide = normalizeNormalSide(body.normalSide);
	const status = body.status === undefined ? 'ACTIVE' : normalizeAccountStatus(body.status);

	return { code, name, normalSide, status };
}

function validateAccountPatchInput(payload: unknown): AccountPatchInput {
	const body = expectObject(payload, 'Account payload must be an object');
	const next: AccountPatchInput = {};

	if (body.code !== undefined) {
		next.code = expectNonEmptyString(body.code, 'Account code must be a non-empty string');
	}
	if (body.name !== undefined) {
		next.name = expectNonEmptyString(body.name, 'Account name must be a non-empty string');
	}
	if (body.normalSide !== undefined) {
		next.normalSide = normalizeNormalSide(body.normalSide);
	}
	if (body.status !== undefined) {
		next.status = normalizeAccountStatus(body.status);
	}

	return next;
}

function validateTransactionInput(payload: unknown): TransactionInput {
	const body = expectObject(payload, 'Transaction payload must be an object');
	return {
		description: optionalText(body.description),
		reference: optionalText(body.reference),
		status: body.status === undefined ? 'CREATED' : normalizeTransactionStatus(body.status),
		entries: expectArray(body.entries, 'Transaction entries are required'),
	};
}

function validateTransactionPatchInput(payload: unknown): TransactionPatchInput {
	const body = expectObject(payload, 'Transaction payload must be an object');
	const next: TransactionPatchInput = {};

	if (body.description !== undefined) {
		next.description = optionalText(body.description);
	}
	if (body.reference !== undefined) {
		next.reference = optionalText(body.reference);
	}
	if (body.status !== undefined) {
		next.status = normalizeTransactionStatus(body.status);
	}
	if (body.entries !== undefined) {
		next.entries = expectArray(body.entries, 'Transaction entries must be an array');
	}

	return next;
}

function validateEntries(entries: unknown[]): EntryInput[] {
	if (entries.length < 2) {
		throw new HttpError(400, 'A transaction must contain at least 2 entries');
	}

	const normalizedEntries = entries.map((entry, index) => {
		const item = expectObject(entry, `Entry at index ${index} must be an object`);
		const accountId = expectPositiveInteger(item.accountId, `Entry at index ${index} must include a valid accountId`);
		const direction = normalizeEntryDirection(item.direction);
		const amount = expectPositiveNumber(item.amount, `Entry at index ${index} must include a positive amount`);

		return { accountId, direction, amount };
	});

	const debitTotal = sumEntries(normalizedEntries, 'DEBIT');
	const creditTotal = sumEntries(normalizedEntries, 'CREDIT');
	if (Math.abs(debitTotal - creditTotal) > EPSILON) {
		throw new HttpError(400, 'Debit and credit totals must balance to zero', {
			debitTotal,
			creditTotal,
			difference: debitTotal - creditTotal,
		});
	}

	return normalizedEntries;
}

function assertAllowedTransition(currentStatus: TransactionStatus, nextStatus: TransactionStatus): void {
	if (!ACCOUNT_TRANSITIONS[currentStatus].includes(nextStatus)) {
		throw new HttpError(409, `Cannot transition a transaction from ${currentStatus} to ${nextStatus}`);
	}
}

function shouldRecomputeBalances(previousStatus: TransactionStatus, nextStatus: TransactionStatus): boolean {
	const impactsBalances = (status: TransactionStatus) => status === 'PENDING' || status === 'POSTED';
	return impactsBalances(previousStatus) || impactsBalances(nextStatus);
}

function serializeAccount(row: AccountRow): {
	id: number;
	code: string;
	name: string;
	normalSide: NormalSide;
	status: AccountStatus;
	createdAt: string;
	updatedAt: string;
} {
	return {
		id: row.id,
		code: row.code,
		name: row.name,
		normalSide: row.normal_side,
		status: row.status,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function serializeBalance(row: BalanceRow): BalanceSnapshot {
	return {
		accountId: row.account_id,
		pending: {
			debitTotal: row.pending_debit_total,
			creditTotal: row.pending_credit_total,
			balance: row.pending_balance,
		},
		posted: {
			debitTotal: row.posted_debit_total,
			creditTotal: row.posted_credit_total,
			balance: row.posted_balance,
		},
		updatedAt: row.updated_at,
	};
}

function serializeEntry(row: EntryRow): {
	id: number;
	transactionId: number;
	accountId: number;
	direction: EntryDirection;
	amount: number;
	createdAt: string;
} {
	return {
		id: row.id,
		transactionId: row.transaction_id,
		accountId: row.account_id,
		direction: row.direction,
		amount: row.amount,
		createdAt: row.created_at,
	};
}

function serializeTransaction(
	row: TransactionRow,
	entries: EntryRow[],
): {
	id: number;
	description: string | null;
	reference: string | null;
	status: TransactionStatus;
	createdAt: string;
	updatedAt: string;
	entries: ReturnType<typeof serializeEntry>[];
} {
	return {
		id: row.id,
		description: row.description,
		reference: row.reference,
		status: row.status,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		entries: entries.map(serializeEntry),
	};
}

function computeBalance(normalSide: NormalSide, debitTotal: number, creditTotal: number): number {
	return normalSide === 'DEBIT' ? debitTotal - creditTotal : creditTotal - debitTotal;
}

function sumEntries(entries: EntryInput[], direction: EntryDirection): number {
	return entries
		.filter((entry) => entry.direction === direction)
		.reduce((total, entry) => total + entry.amount, 0);
}

function normalizeTransactionStatus(value: unknown): TransactionStatus {
	const normalized = expectNonEmptyString(value, 'Transaction status must be a non-empty string').toUpperCase();
	if (!TRANSACTION_STATUSES.includes(normalized as TransactionStatus)) {
		throw new HttpError(400, `Invalid transaction status: ${String(value)}`);
	}
	return normalized as TransactionStatus;
}

function normalizeEntryDirection(value: unknown): EntryDirection {
	const normalized = expectNonEmptyString(value, 'Entry direction must be a non-empty string').toUpperCase();
	if (!ENTRY_DIRECTIONS.includes(normalized as EntryDirection)) {
		throw new HttpError(400, `Invalid entry direction: ${String(value)}`);
	}
	return normalized as EntryDirection;
}

function normalizeNormalSide(value: unknown): NormalSide {
	const normalized = expectNonEmptyString(value, 'Account normalSide must be a non-empty string').toUpperCase();
	if (!NORMAL_SIDES.includes(normalized as NormalSide)) {
		throw new HttpError(400, `Invalid account normalSide: ${String(value)}`);
	}
	return normalized as NormalSide;
}

function normalizeAccountStatus(value: unknown): AccountStatus {
	const normalized = expectNonEmptyString(value, 'Account status must be a non-empty string').toUpperCase();
	if (!ACCOUNT_STATUSES.includes(normalized as AccountStatus)) {
		throw new HttpError(400, `Invalid account status: ${String(value)}`);
	}
	return normalized as AccountStatus;
}

function expectObject(value: unknown, message: string): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new HttpError(400, message);
	}
	return value as Record<string, unknown>;
}

function expectArray(value: unknown, message: string): unknown[] {
	if (!Array.isArray(value)) {
		throw new HttpError(400, message);
	}
	return value;
}

function expectNonEmptyString(value: unknown, message: string): string {
	if (typeof value !== 'string' || value.trim().length === 0) {
		throw new HttpError(400, message);
	}
	return value.trim();
}

function expectPositiveInteger(value: unknown, message: string): number {
	if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
		throw new HttpError(400, message);
	}
	return value;
}

function expectPositiveNumber(value: unknown, message: string): number {
	if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
		throw new HttpError(400, message);
	}
	return value;
}

function optionalText(value: unknown): string | null | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (value === null) {
		return null;
	}
	if (typeof value !== 'string') {
		throw new HttpError(400, 'Expected text field to be a string or null');
	}
	const trimmed = value.trim();
	return trimmed.length === 0 ? null : trimmed;
}

function nullableText(value: string | null | undefined): string | null {
	return value === undefined ? null : value;
}

function parseId(value: string, label: string): number {
	const parsed = Number.parseInt(value, 10);
	if (!Number.isInteger(parsed) || parsed <= 0) {
		throw new HttpError(400, `Invalid ${label}`);
	}
	return parsed;
}

function normalizePath(pathname: string): string {
	if (pathname.length > 1 && pathname.endsWith('/')) {
		return pathname.replace(/\/+$/, '');
	}
	return pathname;
}

function buildPlaceholders(length: number): string {
	return Array.from({ length }, () => '?').join(', ');
}

function uniqueNumbers(values: number[]): number[] {
	return [...new Set(values)];
}

function withTransaction<T>(callback: () => T): T {
	db.exec('BEGIN');
	try {
		const result = callback();
		db.exec('COMMIT');
		return result;
	} catch (error) {
		if (db.isTransaction) {
			db.exec('ROLLBACK');
		}
		throw error;
	}
}

function wrapSqliteError(error: unknown, message: string): Error {
	if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
		return new HttpError(409, message);
	}
	return error instanceof Error ? error : new Error(String(error));
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on('data', (chunk: Buffer) => {
			chunks.push(chunk);
		});
		req.on('end', () => {
			if (chunks.length === 0) {
				resolve({});
				return;
			}

			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
			} catch {
				reject(new HttpError(400, 'Request body must be valid JSON'));
			}
		});
		req.on('error', (error: Error) => reject(error));
	});
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
	const body = JSON.stringify(payload, null, 2);
	res.writeHead(statusCode, {
		'content-type': 'application/json; charset=utf-8',
		'content-length': Buffer.byteLength(body),
	});
	res.end(body);
}

function sendNoContent(res: ServerResponse): void {
	res.writeHead(204);
	res.end();
}

function handleError(res: ServerResponse, error: unknown): void {
	if (error instanceof HttpError) {
		const payload: Record<string, unknown> = { error: error.message };
		if (error.details !== undefined) {
			payload.details = error.details;
		}
		sendJson(res, error.statusCode, payload);
		return;
	}

	const message = error instanceof Error ? error.message : 'Unexpected error';
	sendJson(res, 500, { error: message });
}
