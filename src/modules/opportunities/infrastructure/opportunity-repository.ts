export interface OpportunityRepository {
  list(): Promise<Array<{
    url: string;
    oportunidade: string;
    nota?: number | null;
    estado?: string;
  }>>;
}

export class InMemoryOpportunityRepository implements OpportunityRepository {
  private readonly items: Array<{
    url: string;
    oportunidade: string;
    nota?: number | null;
    estado?: string;
  }> = [];

  async list() {
    return this.items;
  }

  add(item: { url: string; oportunidade: string; nota?: number | null; estado?: string }) {
    this.items.push(item);
  }
}
