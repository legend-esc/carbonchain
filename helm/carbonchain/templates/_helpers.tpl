{{/*
Expand the name of the chart.
*/}}
{{- define "carbonchain.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "carbonchain.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Create chart name and version as used by the chart label.
*/}}
{{- define "carbonchain.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "carbonchain.labels" -}}
helm.sh/chart: {{ include "carbonchain.chart" . }}
{{ include "carbonchain.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "carbonchain.selectorLabels" -}}
app.kubernetes.io/name: {{ include "carbonchain.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Compute comma-separated Redis Sentinel hosts for API configuration
*/}}
{{- define "carbonchain.redisSentinelHosts" -}}
{{- $fullname := include "carbonchain.fullname" . -}}
{{- $ns := .Release.Namespace -}}
{{- $port := .Values.redisSentinel.sentinelPort | int -}}
{{- $replicas := .Values.redisSentinel.sentinelReplicas | int -}}
{{- $hosts := list -}}
{{- range $i := until $replicas -}}
{{- $hosts = append $hosts (printf "%s-redis-sentinel-%d.%s-redis-sentinel-headless.%s.svc.cluster.local:%d" $fullname $i $fullname $ns $port) -}}
{{- end -}}
{{- join "," $hosts -}}
{{- end }}
