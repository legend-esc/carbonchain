/**
 * Issue #1320 — GraphQL resolvers for credit metadata and ownership.
 *
 * Implements Query and field resolvers for Credit, Project, Retirement and
 * Verifier types defined in `schema.gql`.  DataLoader instances batch
 * per-request loads of Credits and Projects to avoid N+1 queries.
 */
import { Resolver, Query, ResolveField, Args, Parent } from '@nestjs/graphql';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, FindOptionsWhere } from 'typeorm';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import DataLoader = require('dataloader');
import { CreditEntity } from '../credits/credit.entity';
import { ProjectEntity } from '../projects/project.entity';
import { RetirementEntity } from '../retirement/retirement.entity';
import { VerifierEntity } from '../verifiers/verifier.entity';

/** Optional filter shape accepted by the `credits` / `projects` queries. */
interface CreditFilter {
  methodology?: string;
  geography?: string;
  status?: string;
  owner?: string;
  projectId?: string;
  vintageYear?: number;
}

@Resolver('Credit')
export class CreditResolver {
  /**
   * Per-instance DataLoaders.
   *
   * In a production deployment these should be scoped to the GraphQL request
   * context (e.g. via a NestJS REQUEST-scoped provider or a DataLoader factory
   * injected through GqlExecutionContext) so each request gets a fresh loader.
   * For simplicity the loaders are created per resolver instance here; they
   * still batch concurrent loads within a single event-loop tick.
   */
  private readonly creditLoader: DataLoader<string, CreditEntity | null>;
  private readonly projectLoader: DataLoader<string, ProjectEntity | null>;

  constructor(
    @InjectRepository(CreditEntity)
    private readonly creditRepository: Repository<CreditEntity>,

    @InjectRepository(ProjectEntity)
    private readonly projectRepository: Repository<ProjectEntity>,

    @InjectRepository(RetirementEntity)
    private readonly retirementRepository: Repository<RetirementEntity>,

    @InjectRepository(VerifierEntity)
    private readonly verifierRepository: Repository<VerifierEntity>,
  ) {
    this.creditLoader = new DataLoader<string, CreditEntity | null>(
      async (ids: readonly string[]) => {
        const credits = await this.creditRepository.findByIds([...ids]);
        const map = new Map(credits.map((c) => [c.id, c]));
        return ids.map((id) => map.get(id) ?? null);
      },
    );

    this.projectLoader = new DataLoader<string, ProjectEntity | null>(
      async (ids: readonly string[]) => {
        const projects = await this.projectRepository.findByIds([...ids]);
        const map = new Map(projects.map((p) => [p.id, p]));
        return ids.map((id) => map.get(id) ?? null);
      },
    );
  }

  // ── Query resolvers ─────────────────────────────────────────────────────────

  @Query('credit')
  async getCredit(@Args('id') id: string): Promise<CreditEntity | null> {
    return this.creditLoader.load(id);
  }

  @Query('credits')
  async getCredits(
    @Args('filter') filter?: CreditFilter,
  ): Promise<CreditEntity[]> {
    if (!filter) {
      return this.creditRepository.find();
    }

    const where: FindOptionsWhere<CreditEntity> = {};
    if (filter.methodology !== undefined)
      where.methodology = filter.methodology;
    if (filter.geography !== undefined) where.geography = filter.geography;
    if (filter.status !== undefined) where.status = filter.status as any;
    if (filter.owner !== undefined) where.owner = filter.owner;
    if (filter.projectId !== undefined) where.projectId = filter.projectId;
    if (filter.vintageYear !== undefined)
      where.vintageYear = filter.vintageYear;

    return this.creditRepository.findBy(where);
  }

  @Query('project')
  async getProject(@Args('id') id: string): Promise<ProjectEntity | null> {
    return this.projectLoader.load(id);
  }

  @Query('projects')
  async getProjects(
    @Args('filter') filter?: CreditFilter,
  ): Promise<ProjectEntity[]> {
    if (!filter) {
      return this.projectRepository.find();
    }

    const where: FindOptionsWhere<ProjectEntity> = {};
    if (filter.methodology !== undefined)
      where.methodology = filter.methodology;

    return this.projectRepository.findBy(where);
  }

  @Query('verifier')
  async getVerifier(
    @Args('address') address: string,
  ): Promise<VerifierEntity | null> {
    return this.verifierRepository.findOneBy({ address }) ?? null;
  }

  @Query('verifiers')
  async getVerifiers(): Promise<VerifierEntity[]> {
    return this.verifierRepository.find();
  }

  @Query('retirement')
  async getRetirement(
    @Args('id') id: string,
  ): Promise<RetirementEntity | null> {
    return this.retirementRepository.findOneBy({ id }) ?? null;
  }

  // ── Field resolvers ─────────────────────────────────────────────────────────

  /**
   * Resolve `Credit.project` via DataLoader to batch-load projects for a
   * list of credits in a single DB round-trip.
   */
  @ResolveField('project')
  async resolveProject(
    @Parent() credit: CreditEntity,
  ): Promise<ProjectEntity | null> {
    if (!credit.projectId) return null;
    return this.projectLoader.load(credit.projectId);
  }

  /**
   * Resolve `Credit.retirements` by querying all retirement records for
   * the given credit ID.
   */
  @ResolveField('retirements')
  async resolveRetirements(
    @Parent() credit: CreditEntity,
  ): Promise<RetirementEntity[]> {
    return this.retirementRepository.findBy({ creditId: credit.id });
  }
}
