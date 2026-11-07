#!/usr/bin/env bash
# hw-28: знести кластер. Стан Pulumi (.pulumi/) лишається — його прибирає `npm run destroy` ДО цього.
set -euo pipefail
kind delete cluster --name "${CLUSTER:-hw28}"
