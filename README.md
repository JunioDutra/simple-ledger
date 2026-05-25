# Simple Ledger Single File

Servico de ledger simples em um unico arquivo TypeScript, usando apenas Node.js nativo, `node:sqlite` e `node:http`.

O projeto implementa:
- CRUD de contas
- CRUD de transacoes
- Regra basica de double entry
- Saldos materializados por conta para `pending` e `posted`
- Persistencia em SQLite

## Requisitos

- Node.js 26+
- npm

## Como rodar

```bash
npm install
npm start
```

O servico sobe em:

```bash
http://localhost:3000
```

O banco SQLite e criado automaticamente na raiz do projeto com o nome `ledger.sqlite`.

## Regras principais

- Toda transacao precisa ter pelo menos 2 entries.
- A soma dos debitos deve ser igual a soma dos creditos.
- `CREATED` nao afeta saldo.
- `PENDING` afeta apenas o saldo `pending`.
- `POSTED` afeta apenas o saldo `posted`.
- Ao mover uma transacao de `PENDING` para `POSTED`, o efeito sai de `pending` e entra em `posted`.
- Transacao `POSTED` nao pode ser alterada nem removida.

## Endpoints

### Contas

- `GET /account`
- `GET /account/:id`
- `POST /account`
- `PATCH /account/:id`
- `DELETE /account/:id`
- `GET /account/:id/balance`

### Transacoes

- `GET /transaction`
- `GET /transaction/:id`
- `POST /transaction`
- `PATCH /transaction/:id`
- `DELETE /transaction/:id`

## Exemplos com curl

Defina a base da API:

```bash
BASE_URL=http://localhost:3000
```

### 1. Criar duas contas

Conta de caixa:

```bash
curl -X POST "$BASE_URL/account" \
  -H "Content-Type: application/json" \
  -d '{
    "code": "1000",
    "name": "Caixa",
    "normalSide": "DEBIT",
    "status": "ACTIVE"
  }'
```

Conta de receita:

```bash
curl -X POST "$BASE_URL/account" \
  -H "Content-Type: application/json" \
  -d '{
    "code": "4000",
    "name": "Receita de Servicos",
    "normalSide": "CREDIT",
    "status": "ACTIVE"
  }'
```

### 2. Listar contas

```bash
curl "$BASE_URL/account"
```

### 3. Buscar uma conta especifica

```bash
curl "$BASE_URL/account/1"
```

### 4. Consultar o saldo de uma conta

```bash
curl "$BASE_URL/account/1/balance"
```

### 5. Criar uma transacao `PENDING`

Este exemplo cria uma venda simples de 150.00. O saldo `pending` sera atualizado.

```bash
curl -X POST "$BASE_URL/transaction" \
  -H "Content-Type: application/json" \
  -d '{
    "description": "Venda pendente",
    "reference": "VENDA-001",
    "status": "PENDING",
    "entries": [
      {
        "accountId": 1,
        "direction": "DEBIT",
        "amount": 150
      },
      {
        "accountId": 2,
        "direction": "CREDIT",
        "amount": 150
      }
    ]
  }'
```

### 6. Ver o saldo apos a transacao pendente

```bash
curl "$BASE_URL/account/1/balance"
curl "$BASE_URL/account/2/balance"
```

### 7. Promover a transacao para `POSTED`

Assumindo que a transacao criada tenha `id = 1`:

```bash
curl -X PATCH "$BASE_URL/transaction/1" \
  -H "Content-Type: application/json" \
  -d '{
    "status": "POSTED"
  }'
```

Agora o efeito sai do saldo `pending` e entra no saldo `posted`.

### 8. Criar uma transacao ja em `POSTED`

```bash
curl -X POST "$BASE_URL/transaction" \
  -H "Content-Type: application/json" \
  -d '{
    "description": "Recebimento confirmado",
    "reference": "REC-001",
    "status": "POSTED",
    "entries": [
      {
        "accountId": 1,
        "direction": "DEBIT",
        "amount": 200
      },
      {
        "accountId": 2,
        "direction": "CREDIT",
        "amount": 200
      }
    ]
  }'
```

### 9. Listar transacoes

```bash
curl "$BASE_URL/transaction"
```

### 10. Buscar uma transacao especifica

```bash
curl "$BASE_URL/transaction/1"
```

### 11. Atualizar uma conta

```bash
curl -X PATCH "$BASE_URL/account/1" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Caixa Principal"
  }'
```

### 12. Atualizar uma transacao `PENDING`

Este exemplo altera descricao e entries. So funciona se a transacao ainda nao estiver `POSTED`.

```bash
curl -X PATCH "$BASE_URL/transaction/1" \
  -H "Content-Type: application/json" \
  -d '{
    "description": "Venda pendente ajustada",
    "entries": [
      {
        "accountId": 1,
        "direction": "DEBIT",
        "amount": 175
      },
      {
        "accountId": 2,
        "direction": "CREDIT",
        "amount": 175
      }
    ]
  }'
```

### 13. Remover uma transacao `PENDING` ou `CREATED`

```bash
curl -X DELETE "$BASE_URL/transaction/1"
```

### 14. Remover uma conta sem historico

```bash
curl -X DELETE "$BASE_URL/account/3"
```

## Exemplo de erro de double entry

Este payload e invalido porque debitos e creditos nao fecham:

```bash
curl -X POST "$BASE_URL/transaction" \
  -H "Content-Type: application/json" \
  -d '{
    "description": "Transacao invalida",
    "status": "PENDING",
    "entries": [
      {
        "accountId": 1,
        "direction": "DEBIT",
        "amount": 100
      },
      {
        "accountId": 2,
        "direction": "CREDIT",
        "amount": 90
      }
    ]
  }'
```

## Estrutura do projeto

- `app.ts`: servico inteiro, com schema, regras, roteamento e persistencia.
- `ledger.sqlite`: banco criado automaticamente em runtime.
- `tsconfig.json`: configuracao minima para o TypeScript do editor.

## Observacoes

- O projeto foi feito para ser simples e direto, nao para ser um framework completo.
- Nao existe autenticacao.
- Nao existem migracoes formais; o schema e inicializado automaticamente na subida.
