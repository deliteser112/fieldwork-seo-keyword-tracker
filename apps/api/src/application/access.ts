export interface Account {
  id: string;
  email: string;
  passwordHash: string;
}
export interface Principal {
  id: string;
  email: string;
}
export interface OwnedClient {
  id: string;
  name: string;
  websiteUrl: string;
}
export interface IdentityStore {
  accountByEmail(email: string): Promise<Account | null>;
  createSession(
    userId: string,
    tokenHash: string,
    expiresAt: Date,
    previousTokenHash?: string,
  ): Promise<void>;
  principalBySession(tokenHash: string, now: Date): Promise<Principal | null>;
  revokeSession(tokenHash: string): Promise<void>;
  clientsFor(ownerId: string): Promise<OwnedClient[]>;
  clientFor(ownerId: string, id: string): Promise<OwnedClient | null>;
}
export interface Credentials {
  verify(hash: string, password: string): Promise<boolean>;
  dummyHash: string;
  issue(): string;
  digest(token: string): string;
  csrf(token: string): string;
  matches(a: string, b: string): boolean;
}
export class AccessDenied extends Error {}
export class AccessService {
  constructor(
    private readonly store: IdentityStore,
    private readonly credentials: Credentials,
    private readonly ttlSeconds: number,
  ) {}
  async login(
    email: string,
    password: string,
    previousToken?: string,
  ): Promise<{ user: Principal; token: string; csrfToken: string }> {
    const account = await this.store.accountByEmail(email.trim().toLowerCase());
    const valid = await this.credentials.verify(
      account?.passwordHash ?? this.credentials.dummyHash,
      password,
    );
    if (!account || !valid) throw new AccessDenied();
    const token = this.credentials.issue();
    await this.store.createSession(
      account.id,
      this.credentials.digest(token),
      new Date(Date.now() + this.ttlSeconds * 1000),
      previousToken ? this.credentials.digest(previousToken) : undefined,
    );
    return {
      user: { id: account.id, email: account.email },
      token,
      csrfToken: this.credentials.csrf(token),
    };
  }
  async authenticate(token: string | undefined): Promise<Principal> {
    if (!token || !/^[a-f0-9]{64}$/.test(token)) throw new AccessDenied();
    const user = await this.store.principalBySession(
      this.credentials.digest(token),
      new Date(),
    );
    if (!user) throw new AccessDenied();
    return user;
  }
  csrf(token: string): string {
    return this.credentials.csrf(token);
  }
  validCsrf(token: string, value: unknown): boolean {
    return (
      typeof value === "string" &&
      this.credentials.matches(this.csrf(token), value)
    );
  }
  async logout(token: string): Promise<void> {
    await this.store.revokeSession(this.credentials.digest(token));
  }
  clients(owner: Principal): Promise<OwnedClient[]> {
    return this.store.clientsFor(owner.id);
  }
  client(owner: Principal, id: string): Promise<OwnedClient | null> {
    return this.store.clientFor(owner.id, id);
  }
}
