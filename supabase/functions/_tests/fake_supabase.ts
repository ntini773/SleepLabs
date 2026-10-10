// In-memory stand-in for `@supabase/supabase-js`. Tests use it through an import map.
// It supports only the calls the Edge Functions make: select, insert, update, delete,
// eq, is, lt, lte, in, or, order, limit, maybeSingle, single, and auth.getUser /
// auth.admin.generateLink. Tests reset it with resetStore() before each case.

// Test data is loosely typed on purpose. Rows mirror database tables.
// deno-lint-ignore no-explicit-any
export type Row = Record<string, any>;
type Result = { data: unknown; error: { message: string } | null };

export type FakeUser = {
  id: string;
  email?: string;
  email_confirmed_at?: string | null;
};

type WriteFailure = {
  table: string;
  op: "insert" | "update" | "delete";
  times: number;
  message: string;
  // Only fail when the written values match. For example, only the "email_sent" save.
  matchPayload?: (payload: Row) => boolean;
};

export const store = {
  tables: {} as Record<string, Row[]>,
  // Access token -> user, used by auth.getUser.
  usersByToken: new Map<string, FakeUser>(),
  // Email -> auth user id, created by generateLink.
  authIdsByEmail: new Map<string, string>(),
  failures: [] as WriteFailure[],
};

export function resetStore() {
  store.tables = {};
  store.usersByToken = new Map();
  store.authIdsByEmail = new Map();
  store.failures = [];
}

export function rowsOf(tableName: string): Row[] {
  if (!store.tables[tableName]) store.tables[tableName] = [];
  return store.tables[tableName];
}

function newId(): string {
  return crypto.randomUUID();
}

// Compares dates (ISO strings), numbers, and plain strings.
function compareValues(left: unknown, right: unknown): number {
  if (typeof left === "number" && typeof right === "number") return left - right;
  const leftText = String(left);
  const rightText = String(right);
  if (/^\d{4}-\d{2}-\d{2}T/.test(leftText) && /^\d{4}-\d{2}-\d{2}T/.test(rightText)) {
    return Date.parse(leftText) - Date.parse(rightText);
  }
  return leftText.localeCompare(rightText);
}

function isNullish(value: unknown) {
  return value === null || value === undefined;
}

// Parses one clause of an .or() filter, such as "release_at.lt.2026-10-10T00:00:00.000Z".
// The value can contain dots, so only the first two dots split the clause.
function matchesOrClause(row: Row, clause: string): boolean {
  const [column, operator, ...valueParts] = clause.split(".");
  const value = valueParts.join(".");
  const actual = row[column];
  if (operator === "is") return value === "null" ? isNullish(actual) : actual === value;
  if (operator === "eq") return actual === value;
  if (operator === "lt") return !isNullish(actual) && compareValues(actual, value) < 0;
  throw new Error(`Fake supabase: unsupported or() operator "${operator}"`);
}

class Query implements PromiseLike<Result> {
  private filters: Array<(row: Row) => boolean> = [];
  private operation: "select" | "insert" | "update" | "delete" = "select";
  private payload: Row | Row[] = {};
  private returnRows = false;
  private embedParticipantEmail = false;
  private orderColumn: string | null = null;
  private orderAscending = true;
  private rowLimit: number | null = null;
  private singleMode: "none" | "maybe" | "one" = "none";

  constructor(private readonly tableName: string) {}

  select(columns = "*"): this {
    // Writes followed by select() return the written rows.
    this.returnRows = true;
    this.embedParticipantEmail = columns.includes("participants(email)");
    return this;
  }

  insert(values: Row | Row[]): this {
    this.operation = "insert";
    this.payload = values;
    return this;
  }

  update(values: Row): this {
    this.operation = "update";
    this.payload = values;
    return this;
  }

  delete(): this {
    this.operation = "delete";
    return this;
  }

  eq(column: string, value: unknown): this {
    this.filters.push((row) => row[column] === value);
    return this;
  }

  is(column: string, value: null): this {
    this.filters.push((row) => (value === null ? isNullish(row[column]) : row[column] === value));
    return this;
  }

  lt(column: string, value: unknown): this {
    this.filters.push((row) => !isNullish(row[column]) && compareValues(row[column], value) < 0);
    return this;
  }

  lte(column: string, value: unknown): this {
    this.filters.push((row) => !isNullish(row[column]) && compareValues(row[column], value) <= 0);
    return this;
  }

  in(column: string, values: unknown[]): this {
    this.filters.push((row) => values.includes(row[column]));
    return this;
  }

  or(expression: string): this {
    const clauses = expression.split(",");
    this.filters.push((row) => clauses.some((clause) => matchesOrClause(row, clause)));
    return this;
  }

  order(column: string, options?: { ascending?: boolean }): this {
    this.orderColumn = column;
    this.orderAscending = options?.ascending ?? true;
    return this;
  }

  limit(count: number): this {
    this.rowLimit = count;
    return this;
  }

  maybeSingle(): this {
    this.singleMode = "maybe";
    return this;
  }

  single(): this {
    this.singleMode = "one";
    return this;
  }

  then<TResult1 = Result, TResult2 = never>(
    onFulfilled?: ((value: Result) => TResult1 | PromiseLike<TResult1>) | null,
    onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.execute()).then(onFulfilled, onRejected);
  }

  private execute(): Result {
    const rows = rowsOf(this.tableName);
    const matching = rows.filter((row) => this.filters.every((filter) => filter(row)));

    if (this.operation === "select") {
      let selected = matching;
      if (this.orderColumn) {
        const column = this.orderColumn;
        const direction = this.orderAscending ? 1 : -1;
        selected = [...selected].sort((a, b) => direction * compareValues(a[column], b[column]));
      }
      if (this.rowLimit !== null) selected = selected.slice(0, this.rowLimit);
      return this.shape(selected.map((row) => this.withEmbeds(row)));
    }

    const payload = Array.isArray(this.payload) ? null : this.payload;
    const failure = this.findFailure(payload);
    if (failure) {
      failure.times--;
      return { data: null, error: { message: failure.message } };
    }

    if (this.operation === "insert") {
      const inserted = (Array.isArray(this.payload) ? this.payload : [this.payload]).map((values) => {
        const row: Row = { id: newId(), created_at: new Date().toISOString(), ...values };
        rows.push(row);
        return row;
      });
      return this.shape(inserted);
    }

    if (this.operation === "update") {
      for (const row of matching) Object.assign(row, this.payload);
      return this.shape(this.returnRows ? matching : []);
    }

    // delete
    for (const row of matching) rows.splice(rows.indexOf(row), 1);
    return this.shape([]);
  }

  private findFailure(payload: Row | null): WriteFailure | undefined {
    return store.failures.find((failure) =>
      failure.times > 0 &&
      failure.table === this.tableName &&
      failure.op === this.operation &&
      (!failure.matchPayload || (payload !== null && failure.matchPayload(payload)))
    );
  }

  private withEmbeds(row: Row): Row {
    if (!this.embedParticipantEmail) return { ...row };
    const participant = rowsOf("participants").find((candidate) => candidate.id === row.participant_id);
    return { ...row, participants: participant ? { email: participant.email } : null };
  }

  private shape(rows: Row[]): Result {
    if (this.singleMode === "maybe") return { data: rows[0] ?? null, error: null };
    if (this.singleMode === "one") {
      return rows[0]
        ? { data: rows[0], error: null }
        : { data: null, error: { message: "JSON object requested, multiple (or no) rows returned" } };
    }
    return { data: rows, error: null };
  }
}

const auth = {
  getUser: async (token: string) => {
    const user = store.usersByToken.get(token);
    return user
      ? { data: { user }, error: null }
      : { data: { user: null }, error: { message: "invalid JWT" } };
  },
  admin: {
    // Mirrors the shape the functions read: data.user.id and data.properties.action_link.
    generateLink: async (options: { type: string; email: string }) => {
      let userId = store.authIdsByEmail.get(options.email);
      if (!userId) {
        userId = newId();
        store.authIdsByEmail.set(options.email, userId);
      }
      return {
        data: {
          user: { id: userId },
          properties: { action_link: `https://fake-auth.test/verify?email_link=${userId}` },
        },
        error: null,
      };
    },
  },
};

// Returns `any` on purpose. The fake covers only the calls the functions make.
// deno-lint-ignore no-explicit-any
export function createClient(_url: string, _serviceKey: string): any {
  return {
    from: (tableName: string) => new Query(tableName),
    auth,
  };
}
