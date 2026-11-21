terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

provider "google" {
  project = var.gcp_project_id != "" ? var.gcp_project_id : null
  region  = var.gcp_region
}

locals {
  name_prefix = "${var.project_name}-${var.environment}"
  is_aws      = var.cloud_provider == "aws"
  is_gcp      = var.cloud_provider == "gcp"
}

# ==============================================================================
# AWS STAGING INFRASTRUCTURE (VPC, RDS PostgreSQL, ElastiCache Redis, ECS)
# ==============================================================================

resource "aws_vpc" "staging" {
  count                = local.is_aws ? 1 : 0
  cidr_block           = var.vpc_cidr
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = merge(var.tags, { Name = "${local.name_prefix}-vpc" })
}

resource "aws_internet_gateway" "staging" {
  count  = local.is_aws ? 1 : 0
  vpc_id = aws_vpc.staging[0].id

  tags = merge(var.tags, { Name = "${local.name_prefix}-igw" })
}

resource "aws_subnet" "public" {
  count                   = local.is_aws ? length(var.aws_availability_zones) : 0
  vpc_id                  = aws_vpc.staging[0].id
  cidr_block              = cidrsubnet(var.vpc_cidr, 8, count.index)
  availability_zone       = var.aws_availability_zones[count.index]
  map_public_ip_on_launch = true

  tags = merge(var.tags, { Name = "${local.name_prefix}-public-${count.index}" })
}

resource "aws_subnet" "private" {
  count             = local.is_aws ? length(var.aws_availability_zones) : 0
  vpc_id            = aws_vpc.staging[0].id
  cidr_block        = cidrsubnet(var.vpc_cidr, 8, count.index + 10)
  availability_zone = var.aws_availability_zones[count.index]

  tags = merge(var.tags, { Name = "${local.name_prefix}-private-${count.index}" })
}

resource "aws_route_table" "public" {
  count  = local.is_aws ? 1 : 0
  vpc_id = aws_vpc.staging[0].id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.staging[0].id
  }

  tags = merge(var.tags, { Name = "${local.name_prefix}-public-rt" })
}

resource "aws_route_table_association" "public" {
  count          = local.is_aws ? length(var.aws_availability_zones) : 0
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public[0].id
}

resource "aws_security_group" "ecs" {
  count       = local.is_aws ? 1 : 0
  name        = "${local.name_prefix}-ecs-sg"
  description = "Security group for CarbonChain ECS tasks"
  vpc_id      = aws_vpc.staging[0].id

  ingress {
    from_port   = var.container_port
    to_port     = var.container_port
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = var.tags
}

resource "aws_security_group" "rds" {
  count       = local.is_aws ? 1 : 0
  name        = "${local.name_prefix}-rds-sg"
  description = "Allow PostgreSQL access from ECS tasks"
  vpc_id      = aws_vpc.staging[0].id

  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.ecs[0].id]
  }

  tags = var.tags
}

resource "aws_security_group" "redis" {
  count       = local.is_aws ? 1 : 0
  name        = "${local.name_prefix}-redis-sg"
  description = "Allow Redis access from ECS tasks"
  vpc_id      = aws_vpc.staging[0].id

  ingress {
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [aws_security_group.ecs[0].id]
  }

  tags = var.tags
}

# ── AWS Managed PostgreSQL (RDS) ──────────────────────────────────────────────

resource "aws_db_subnet_group" "staging" {
  count      = local.is_aws ? 1 : 0
  name       = "${local.name_prefix}-db-subnet"
  subnet_ids = aws_subnet.private[*].id

  tags = var.tags
}

resource "aws_db_instance" "postgres" {
  count                   = local.is_aws ? 1 : 0
  identifier              = "${local.name_prefix}-postgres"
  engine                  = "postgres"
  engine_version          = "16"
  instance_class          = var.aws_db_instance_class
  allocated_storage       = 20
  storage_encrypted       = true
  db_name                 = var.db_name
  username                = var.db_username
  password                = var.db_password
  db_subnet_group_name    = aws_db_subnet_group.staging[0].name
  vpc_security_group_ids  = [aws_security_group.rds[0].id]
  publicly_accessible     = false
  skip_final_snapshot     = true
  backup_retention_period = 7

  tags = var.tags
}

# ── AWS Managed Redis (ElastiCache) ───────────────────────────────────────────

resource "aws_elasticache_subnet_group" "staging" {
  count      = local.is_aws ? 1 : 0
  name       = "${local.name_prefix}-redis-subnet"
  subnet_ids = aws_subnet.private[*].id
}

resource "aws_elasticache_cluster" "redis" {
  count                = local.is_aws ? 1 : 0
  cluster_id           = "${local.name_prefix}-redis"
  engine               = "redis"
  engine_version       = "7.1"
  node_type            = var.aws_redis_node_type
  num_cache_nodes      = 1
  parameter_group_name = "default.redis7"
  port                 = 6379
  subnet_group_name    = aws_elasticache_subnet_group.staging[0].name
  security_group_ids   = [aws_security_group.redis[0].id]

  tags = var.tags
}

# ── AWS Container Runner (ECS Fargate) ────────────────────────────────────────

resource "aws_ecs_cluster" "staging" {
  count = local.is_aws ? 1 : 0
  name  = "${local.name_prefix}-cluster"

  setting {
    name  = "containerInsights"
    value = "enabled"
  }

  tags = var.tags
}

resource "aws_iam_role" "ecs_task_execution" {
  count = local.is_aws ? 1 : 0
  name  = "${local.name_prefix}-ecs-exec-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
    }]
  })

  tags = var.tags
}

resource "aws_iam_role_policy_attachment" "ecs_task_execution" {
  count      = local.is_aws ? 1 : 0
  role       = aws_iam_role.ecs_task_execution[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_cloudwatch_log_group" "ecs" {
  count             = local.is_aws ? 1 : 0
  name              = "/ecs/${local.name_prefix}-api"
  retention_in_days = 14

  tags = var.tags
}

resource "aws_ecs_task_definition" "api" {
  count                    = local.is_aws ? 1 : 0
  family                   = "${local.name_prefix}-api"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = var.container_cpu
  memory                   = var.container_memory
  execution_role_arn       = aws_iam_role.ecs_task_execution[0].arn

  container_definitions = jsonencode([{
    name      = "api"
    image     = var.container_image
    essential = true
    portMappings = [{
      containerPort = var.container_port
      protocol      = "tcp"
    }]
    environment = [
      { name = "NODE_ENV", value = var.environment },
      { name = "PORT", value = tostring(var.container_port) },
      { name = "DATABASE_HOST", value = aws_db_instance.postgres[0].address },
      { name = "DATABASE_PORT", value = "5432" },
      { name = "DATABASE_NAME", value = var.db_name },
      { name = "REDIS_HOST", value = aws_elasticache_cluster.redis[0].cache_nodes[0].address },
      { name = "REDIS_PORT", value = "6379" },
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.ecs[0].name
        awslogs-region        = var.aws_region
        awslogs-stream-prefix = "ecs"
      }
    }
  }])

  tags = var.tags
}

resource "aws_ecs_service" "api" {
  count           = local.is_aws ? 1 : 0
  name            = "${local.name_prefix}-api"
  cluster         = aws_ecs_cluster.staging[0].id
  task_definition = aws_ecs_task_definition.api[0].arn
  desired_count   = var.desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = aws_subnet.public[*].id
    security_groups  = [aws_security_group.ecs[0].id]
    assign_public_ip = true
  }

  tags = var.tags
}

# ==============================================================================
# GCP STAGING INFRASTRUCTURE (VPC, Cloud SQL, Memorystore, Cloud Run)
# ==============================================================================

resource "google_compute_network" "staging" {
  count                   = local.is_gcp ? 1 : 0
  name                    = "${local.name_prefix}-vpc"
  auto_create_subnetworks = false
}

resource "google_compute_subnetwork" "staging" {
  count         = local.is_gcp ? 1 : 0
  name          = "${local.name_prefix}-subnet"
  ip_cidr_range = cidrsubnet(var.vpc_cidr, 4, 0)
  region        = var.gcp_region
  network       = google_compute_network.staging[0].id
}

resource "google_compute_global_address" "private_ip_range" {
  count         = local.is_gcp ? 1 : 0
  name          = "${local.name_prefix}-private-ip"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 16
  network       = google_compute_network.staging[0].id
}

resource "google_service_networking_connection" "private_vpc_connection" {
  count                   = local.is_gcp ? 1 : 0
  network                 = google_compute_network.staging[0].id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.private_ip_range[0].name]
}

# ── GCP Managed PostgreSQL (Cloud SQL) ────────────────────────────────────────

resource "google_sql_database_instance" "postgres" {
  count               = local.is_gcp ? 1 : 0
  name                = "${local.name_prefix}-postgres"
  database_version    = "POSTGRES_16"
  region              = var.gcp_region
  deletion_protection = false

  depends_on = [google_service_networking_connection.private_vpc_connection]

  settings {
    tier = var.gcp_db_tier
    ip_configuration {
      ipv4_enabled    = false
      private_network = google_compute_network.staging[0].id
    }
    backup_configuration {
      enabled = true
    }
  }
}

resource "google_sql_database" "staging" {
  count    = local.is_gcp ? 1 : 0
  name     = var.db_name
  instance = google_sql_database_instance.postgres[0].name
}

resource "google_sql_user" "staging" {
  count    = local.is_gcp ? 1 : 0
  name     = var.db_username
  instance = google_sql_database_instance.postgres[0].name
  password = var.db_password
}

# ── GCP Managed Redis (Memorystore) ───────────────────────────────────────────

resource "google_redis_instance" "redis" {
  count              = local.is_gcp ? 1 : 0
  name               = "${local.name_prefix}-redis"
  tier               = "BASIC"
  memory_size_gb     = var.gcp_redis_memory_size_gb
  region             = var.gcp_region
  redis_version      = "REDIS_7_2"
  authorized_network = google_compute_network.staging[0].id
  connect_mode       = "PRIVATE_SERVICE_ACCESS"

  depends_on = [google_service_networking_connection.private_vpc_connection]
}

# ── GCP Container Runner (Cloud Run v2) ───────────────────────────────────────

resource "google_cloud_run_v2_service" "api" {
  count    = local.is_gcp ? 1 : 0
  name     = "${local.name_prefix}-api"
  location = var.gcp_region

  template {
    scaling {
      min_instance_count = 1
      max_instance_count = var.desired_count
    }

    vpc_access {
      network_interfaces {
        network    = google_compute_network.staging[0].name
        subnetwork = google_compute_subnetwork.staging[0].name
      }
      egress = "PRIVATE_RANGES_ONLY"
    }

    containers {
      image = var.container_image

      ports {
        container_port = var.container_port
      }

      resources {
        limits = {
          cpu    = "${var.container_cpu}m"
          memory = "${var.container_memory}Mi"
        }
      }

      env {
        name  = "NODE_ENV"
        value = var.environment
      }
      env {
        name  = "DATABASE_HOST"
        value = google_sql_database_instance.postgres[0].private_ip_address
      }
      env {
        name  = "DATABASE_NAME"
        value = var.db_name
      }
      env {
        name  = "REDIS_HOST"
        value = google_redis_instance.redis[0].host
      }
      env {
        name  = "REDIS_PORT"
        value = tostring(google_redis_instance.redis[0].port)
      }
    }
  }
}
