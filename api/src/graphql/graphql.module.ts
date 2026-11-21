/**
 * Issue #1320 — GraphQL module: Apollo + NestJS schema-first setup.
 *
 * Uses `typePaths` to load `schema.gql` at runtime.  The playground is
 * enabled in non-production environments for developer convenience.
 */
import { Module } from '@nestjs/common';
import { GraphQLModule } from '@nestjs/graphql';
import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CreditEntity } from '../credits/credit.entity';
import { ProjectEntity } from '../projects/project.entity';
import { RetirementEntity } from '../retirement/retirement.entity';
import { VerifierEntity } from '../verifiers/verifier.entity';
import { CreditResolver } from './credit.resolver';

@Module({
  imports: [
    GraphQLModule.forRoot<ApolloDriverConfig>({
      driver: ApolloDriver,
      // Load all .gql schema files found anywhere in the dist tree.
      typePaths: ['./**/*.gql'],
      // Enable the Apollo Sandbox / Playground in development.
      playground: process.env.NODE_ENV !== 'production',
    }),
    // Provide TypeORM repositories needed by CreditResolver.
    TypeOrmModule.forFeature([
      CreditEntity,
      ProjectEntity,
      RetirementEntity,
      VerifierEntity,
    ]),
  ],
  providers: [CreditResolver],
  exports: [CreditResolver],
})
export class GraphqlModule {}
