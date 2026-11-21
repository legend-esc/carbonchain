variable "cloud_provider" {
  description = "Target cloud provider for staging deployment (aws or gcp)."
  type        = string
  default     = "aws"

  validation {
    condition     = contains(["aws", "gcp"], var.cloud_provider)
    error_message = "cloud_provider must be either \"aws\" or \"gcp\"."
  }
}

variable "project_name" {
  description = "Project prefix used for naming provisioned resources."
  type        = string
  default     = "carbonchain"
}

variable "environment" {
  description = "Deployment environment name."
  type        = string
  default     = "staging"
}

# ── AWS Settings ──────────────────────────────────────────────────────────────

variable "aws_region" {
  description = "AWS region for staging infrastructure."
  type        = string
  default     = "us-east-1"
}

variable "aws_availability_zones" {
  description = "Availability zones for multi-AZ VPC subnets."
  type        = list(string)
  default     = ["us-east-1a", "us-east-1b"]
}

# ── GCP Settings ──────────────────────────────────────────────────────────────

variable "gcp_project_id" {
  description = "GCP project ID (required when cloud_provider = \"gcp\")."
  type        = string
  default     = ""
}

variable "gcp_region" {
  description = "GCP region for staging infrastructure."
  type        = string
  default     = "us-central1"
}

# ── Networking ────────────────────────────────────────────────────────────────

variable "vpc_cidr" {
  description = "CIDR block for the staging VPC."
  type        = string
  default     = "10.20.0.0/16"
}

# ── Managed PostgreSQL ────────────────────────────────────────────────────────

variable "db_name" {
  description = "Initial PostgreSQL database name."
  type        = string
  default     = "carbonchain"
}

variable "db_username" {
  description = "PostgreSQL master username."
  type        = string
  default     = "carbonchain_admin"
}

variable "db_password" {
  description = "PostgreSQL master password."
  type        = string
  sensitive   = true
}

variable "aws_db_instance_class" {
  description = "RDS PostgreSQL instance class."
  type        = string
  default     = "db.t4g.micro"
}

variable "gcp_db_tier" {
  description = "Cloud SQL PostgreSQL machine tier."
  type        = string
  default     = "db-f1-micro"
}

# ── Managed Redis ─────────────────────────────────────────────────────────────

variable "aws_redis_node_type" {
  description = "ElastiCache Redis node type."
  type        = string
  default     = "cache.t4g.micro"
}

variable "gcp_redis_memory_size_gb" {
  description = "Memorystore Redis instance capacity in GiB."
  type        = number
  default     = 1
}

# ── Container Runner (ECS / Cloud Run) ────────────────────────────────────────

variable "container_image" {
  description = "Container image URI for the CarbonChain API."
  type        = string
  default     = "ghcr.io/legend-esc/carbonchain-api:staging"
}

variable "container_port" {
  description = "Port exposed by the API container."
  type        = number
  default     = 3000
}

variable "container_cpu" {
  description = "CPU units for ECS Fargate task (256 = 0.25 vCPU) or Cloud Run."
  type        = number
  default     = 512
}

variable "container_memory" {
  description = "Memory in MiB for the container runner."
  type        = number
  default     = 1024
}

variable "desired_count" {
  description = "Desired number of running container instances."
  type        = number
  default     = 2
}

variable "tags" {
  description = "Common tags/labels applied to all supported resources."
  type        = map(string)
  default = {
    Project     = "carbonchain"
    ManagedBy   = "terraform"
    Environment = "staging"
  }
}
