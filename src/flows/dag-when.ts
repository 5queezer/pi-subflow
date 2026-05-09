export interface WhenPlaceholderReference {
	task: string;
	path: string[];
}

export class WhenExpressionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WhenExpressionError";
	}
}

type PrimitiveValue = string | number | boolean;

function isPrimitiveValue(value: unknown): value is PrimitiveValue {
	return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

type Expr =
	| { type: "literal"; value: PrimitiveValue }
	| { type: "placeholder"; reference: WhenPlaceholderReference }
	| { type: "unary"; operator: "!"; operand: Expr }
	| { type: "binary"; operator: "&&" | "||" | "==" | "!=" | ">" | ">=" | "<" | "<="; left: Expr; right: Expr };

type Token =
	| { type: "number"; value: number }
	| { type: "string"; value: string }
	| { type: "boolean"; value: boolean }
	| { type: "placeholder"; value: WhenPlaceholderReference }
	| { type: "operator"; value: "&&" | "||" | "==" | "!=" | ">" | ">=" | "<" | "<=" | "!" }
	| { type: "paren"; value: "(" | ")" }
	| { type: "eof" };

export function collectWhenTaskReferences(source: string): string[] {
	const refs = new Set<string>();
	for (const reference of parseWhenExpression(source).references) refs.add(reference.task);
	return [...refs];
}

export function evaluateWhenExpression(source: string, resolve: (reference: WhenPlaceholderReference) => unknown): boolean {
	const expression = parseWhenExpression(source);
	return Boolean(evaluate(expression.ast, resolve));
}

function evaluate(expression: Expr, resolve: (reference: WhenPlaceholderReference) => unknown): unknown {
	switch (expression.type) {
		case "literal":
			return expression.value;
		case "placeholder":
			return resolve(expression.reference);
		case "unary":
			return !Boolean(evaluate(expression.operand, resolve));
		case "binary": {
			if (expression.operator === "&&") return Boolean(evaluate(expression.left, resolve)) && Boolean(evaluate(expression.right, resolve));
			if (expression.operator === "||") return Boolean(evaluate(expression.left, resolve)) || Boolean(evaluate(expression.right, resolve));
			const left = evaluate(expression.left, resolve);
			const right = evaluate(expression.right, resolve);
			if (!isPrimitiveValue(left) || !isPrimitiveValue(right)) throw new WhenExpressionError("comparison operands must be strings, numbers, or booleans");
			switch (expression.operator) {
				case "==": return left === right;
				case "!=": return left !== right;
				case ">": return left > right;
				case ">=": return left >= right;
				case "<": return left < right;
				case "<=": return left <= right;
				default: throw new WhenExpressionError(`unsupported operator: ${expression.operator}`);
			}
		}
	}
}

interface ParsedWhenExpression {
	ast: Expr;
	references: WhenPlaceholderReference[];
}

function parseWhenExpression(source: string): ParsedWhenExpression {
	const parser = new Parser(source);
	const ast = parser.parseExpression();
	parser.expectEof();
	return { ast, references: parser.references };
}

class Parser {
	private index = 0;
	readonly references: WhenPlaceholderReference[] = [];

	constructor(private readonly source: string) {}

	parseExpression(): Expr {
		return this.parseOr();
	}

	expectEof(): void {
		const token = this.nextToken();
		if (token.type !== "eof") throw new WhenExpressionError(`unexpected token: ${describeToken(token)}`);
	}

	private parseOr(): Expr {
		let expr = this.parseAnd();
		while (this.peekOperator("||")) {
			this.nextToken();
			expr = { type: "binary", operator: "||", left: expr, right: this.parseAnd() };
		}
		return expr;
	}

	private parseAnd(): Expr {
		let expr = this.parseEquality();
		while (this.peekOperator("&&")) {
			this.nextToken();
			expr = { type: "binary", operator: "&&", left: expr, right: this.parseEquality() };
		}
		return expr;
	}

	private parseEquality(): Expr {
		let expr = this.parseRelational();
		while (true) {
			if (this.peekOperator("==")) {
				this.nextToken();
				expr = { type: "binary", operator: "==", left: expr, right: this.parseRelational() };
				continue;
			}
			if (this.peekOperator("!=")) {
				this.nextToken();
				expr = { type: "binary", operator: "!=", left: expr, right: this.parseRelational() };
				continue;
			}
			return expr;
		}
	}

	private parseRelational(): Expr {
		let expr = this.parseUnary();
		while (true) {
			if (this.peekOperator(">")) {
				this.nextToken();
				expr = { type: "binary", operator: ">", left: expr, right: this.parseUnary() };
				continue;
			}
			if (this.peekOperator(">=")) {
				this.nextToken();
				expr = { type: "binary", operator: ">=", left: expr, right: this.parseUnary() };
				continue;
			}
			if (this.peekOperator("<")) {
				this.nextToken();
				expr = { type: "binary", operator: "<", left: expr, right: this.parseUnary() };
				continue;
			}
			if (this.peekOperator("<=")) {
				this.nextToken();
				expr = { type: "binary", operator: "<=", left: expr, right: this.parseUnary() };
				continue;
			}
			return expr;
		}
	}

	private parseUnary(): Expr {
		if (this.peekOperator("!")) {
			this.nextToken();
			return { type: "unary", operator: "!", operand: this.parseUnary() };
		}
		return this.parsePrimary();
	}

	private parsePrimary(): Expr {
		const token = this.nextToken();
		switch (token.type) {
			case "number":
			case "string":
			case "boolean":
				return { type: "literal", value: token.value };
			case "placeholder":
				this.references.push(token.value);
				return { type: "placeholder", reference: token.value };
			case "paren":
				if (token.value === "(") {
					const expr = this.parseExpression();
					const close = this.nextToken();
					if (close.type !== "paren" || close.value !== ")") throw new WhenExpressionError("missing closing parenthesis");
					return expr;
				}
				break;
			case "eof":
				throw new WhenExpressionError("unexpected end of expression");
			default:
				break;
		}
		throw new WhenExpressionError(`unexpected token: ${describeToken(token)}`);
	}

	private peekOperator(value: string): boolean {
		const token = this.peekToken();
		return token.type === "operator" && token.value === value;
	}

	private nextToken(): Token {
		this.skipWhitespace();
		if (this.index >= this.source.length) return { type: "eof" };
		const char = this.source[this.index];
		const next = this.source[this.index + 1];
		if (char === "$" && next === "{") return this.readPlaceholder();
		if (char === "(" || char === ")") {
			this.index += 1;
			return { type: "paren", value: char };
		}
		const two = this.source.slice(this.index, this.index + 2);
		if (two === "&&" || two === "||" || two === "==" || two === "!=" || two === ">=" || two === "<=") {
			this.index += 2;
			return { type: "operator", value: two };
		}
		if (char === "!" || char === ">" || char === "<") {
			this.index += 1;
			return { type: "operator", value: char };
		}
		if (char === '"' || char === "'") return this.readString(char);
		if (isNumberStart(char, next)) return this.readNumber();
		if (this.source.startsWith("true", this.index) && !isIdentifierChar(this.source[this.index + 4] ?? "")) {
			this.index += 4;
			return { type: "boolean", value: true };
		}
		if (this.source.startsWith("false", this.index) && !isIdentifierChar(this.source[this.index + 5] ?? "")) {
			this.index += 5;
			return { type: "boolean", value: false };
		}
		throw new WhenExpressionError(`unexpected token: ${char}`);
	}

	private peekToken(): Token {
		const saved = this.index;
		const token = this.nextToken();
		this.index = saved;
		return token;
	}

	private readPlaceholder(): Token {
		this.index += 2;
		const start = this.index;
		let depth = 1;
		while (this.index < this.source.length) {
			if (this.source[this.index] === "}") {
				depth -= 1;
				if (depth === 0) break;
			}
			this.index += 1;
		}
		if (this.index >= this.source.length) throw new WhenExpressionError("unterminated placeholder");
		const raw = this.source.slice(start, this.index).trim();
		this.index += 1;
		return { type: "placeholder", value: parsePlaceholderReference(raw) };
	}

	private readString(quote: '"' | "'"): Token {
		this.index += 1;
		let value = "";
		while (this.index < this.source.length) {
			const char = this.source[this.index];
			if (char === quote) {
				this.index += 1;
				return { type: "string", value };
			}
			if (char === "\\") {
				this.index += 1;
				if (this.index >= this.source.length) throw new WhenExpressionError("unterminated string literal");
				value += parseEscape(this.source[this.index]);
				this.index += 1;
				continue;
			}
			value += char;
			this.index += 1;
		}
		throw new WhenExpressionError("unterminated string literal");
	}

	private readNumber(): Token {
		const start = this.index;
		if (this.source[this.index] === "-") this.index += 1;
		if (this.source[this.index] === ".") {
			this.index += 1;
			this.readDigits();
			return { type: "number", value: Number(this.source.slice(start, this.index)) };
		}
		this.readDigits();
		if (this.source[this.index] === ".") {
			this.index += 1;
			this.readDigits();
		}
		if (this.source[this.index] === "e" || this.source[this.index] === "E") {
			this.index += 1;
			if (this.source[this.index] === "+" || this.source[this.index] === "-") this.index += 1;
			this.readDigits();
		}
		return { type: "number", value: Number(this.source.slice(start, this.index)) };
	}

	private readDigits(): void {
		const start = this.index;
		while (isDigit(this.source[this.index] ?? "")) this.index += 1;
		if (this.index === start) throw new WhenExpressionError("invalid number literal");
	}

	skipWhitespace(): void {
		while (this.index < this.source.length && /\s/u.test(this.source[this.index] ?? "")) this.index += 1;
	}
}

function parsePlaceholderReference(raw: string): WhenPlaceholderReference {
	const match = /^([A-Za-z0-9_-]+)\.output(?:\.([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*))?$/.exec(raw);
	if (!match) throw new WhenExpressionError(`invalid placeholder: ${raw}`);
	const path = match[2]?.split(".") ?? [];
	return { task: match[1], path };
}

function parseEscape(char: string): string {
	switch (char) {
		case "n": return "\n";
		case "r": return "\r";
		case "t": return "\t";
		case "b": return "\b";
		case "f": return "\f";
		case "\\": return "\\";
		case '"': return '"';
		case "'": return "'";
		default: return char;
	}
}

function describeToken(token: Token): string {
	if (token.type === "eof") return "end of expression";
	if (token.type === "paren") return token.value;
	if (token.type === "operator") return token.value;
	if (token.type === "boolean") return String(token.value);
	if (token.type === "number") return String(token.value);
	if (token.type === "string") return JSON.stringify(token.value);
	return "placeholder";
}

function isNumberStart(char: string, next: string | undefined): boolean {
	return isDigit(char) || (char === "-" && (isDigit(next ?? "") || next === ".")) || (char === "." && isDigit(next ?? ""));
}

function isDigit(char: string): boolean {
	return char >= "0" && char <= "9";
}

function isIdentifierChar(char: string): boolean {
	return /[A-Za-z0-9_-]/u.test(char);
}
