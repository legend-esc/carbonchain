output "cloud_provider" {
  description = "Active cloud provider for the staging environment."
  value       = var.cloud_provider
}

output "vpc_id" {
  description = "ID of the provisioned staging VPC."
  value = local.is_aws ? aws_vpc.staging[0].id : (
    local.is_gcp ? google_compute_network.staging[0].id : null
  )
}

output "postgres_endpoint" {
  description = "Private endpoint / IP of the managed PostgreSQL instance."
  value = local.is_aws ? aws_db_instance.postgres[0].endpoint : (
    local.is_gcp ? google_sql_database_instance.postgres[0].private_ip_address : null
  )
}

output "redis_endpoint" {
  description = "Private endpoint of the managed Redis instance."
  value = local.is_aws ? "${aws_elasticache_cluster.redis[0].cache_nodes[0].address}:${aws_elasticache_cluster.redis[0].port}" : (
    local.is_gcp ? "${google_redis_instance.redis[0].host}:${google_redis_instance.redis[0].port}" : null
  )
}

output "container_service_name" {
  description = "Name of the provisioned container service (ECS service or Cloud Run service)."
  value = local.is_aws ? aws_ecs_service.api[0].name : (
    local.is_gcp ? google_cloud_run_v2_service.api[0].name : null
  )
}

output "cloud_run_url" {
  description = "Public URL of the Cloud Run staging service (GCP only)."
  value       = local.is_gcp ? google_cloud_run_v2_service.api[0].uri : null
}
