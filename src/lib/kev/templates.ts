import type {
  Composition,
  CompositionSpec,
  LayerEdge,
  LayerGroup,
  LayerNode,
  LayerSpec,
  SequenceMessage,
  SequenceParticipant,
  SequenceSpec,
  WorkflowSpec,
} from "@/lib/kev/compose";
import { layoutDefault } from "@/lib/kev/plan";
import { redisDiagramRequest, wikipediaTitle } from "@/lib/kev/research";

/**
 * Typed diagrams for the requests people actually make.
 * The host owns the structure. Jev only confirms the outline, the edges, and the style.
 */

export interface TemplateMatch {
  spec: CompositionSpec;
  context: string;
}

const TIER_RE = /\b(\d+|two|three|four|five)[\s-]*tier\b/i;

export function matchTemplate(message: string): TemplateMatch | null {
  const text = message.trim();
  if (!text) return null;
  if (isRichWebTiers(text)) return richWebTiers();
  if (TIER_RE.test(text)) return null;
  if (isOauth(text)) return oauthSequence();
  if (isCheckout(text)) return checkoutSequence();
  if (isCacheAside(text)) return cacheAsideSequence(text);
  if (isApiSequence(text)) return apiSequence();
  if (isApproval(text)) return approvalWorkflow(text);
  if (isStateMachine(text)) return stateMachine(text);
  if (isEr(text)) return erDiagram(text);
  if (isCqrs(text)) return cqrs();
  if (isEventDriven(text)) return eventDriven(text);
  if (isMicroservices(text)) return microservices();
  if (isCloud(text)) return cloudVpc(text);
  if (isKubernetes(text)) return kubernetes();
  if (isDmz(text)) return dmz();
  if (isCdn(text)) return cdn();
  if (isLoadBalancer(text)) return loadBalancer();
  if (isSystemArchitecture(text)) return systemArchitecture(text);
  return null;
}

/**
 * Small layered diagram for a topic that has a research brief and no template.
 * Returns null when the message is already handled or the brief is empty.
 */
export function composeFromBrief(message: string, summary: string): Composition | null {
  const brief = summary.replace(/\s+/g, " ").trim();
  if (brief.length < 40) return null;
  if (matchTemplate(message) || redisDiagramRequest(message)) return null;
  const topic = wikipediaTitle(message);
  if (!topic) return null;
  const label = topic.length > 32 ? `${topic.slice(0, 31).trim()}…` : topic;
  const spec = briefSpec(label, `${brief} ${message}`);
  return {
    spec,
    colorName: null,
    context: brief,
    researchQuery: topic,
    layout: layoutDefault(spec.kind),
  };
}

function briefSpec(topic: string, blob: string): LayerSpec {
  if (/\b(queue|broker|pub\/sub|pubsub|event stream|kafka|nats)\b/i.test(blob)) {
    return {
      kind: "layers",
      title: `${topic} usage`,
      reply: `Drew ${topic} as a message bus between an app and a worker.`,
      groups: [
        col("producers", "Producers", [node("app", "App", "rectangle")]),
        col("bus", "Bus", [node("broker", topic, "queue")]),
        col("consumers", "Consumers", [node("worker", "Worker", "rectangle")]),
      ],
      edges: [
        edge("app", "broker", "Publish"),
        edge("broker", "worker", "Deliver"),
      ],
    };
  }
  if (/\b(cache|caching|in-memory|memcache)\b/i.test(blob)) {
    return {
      kind: "layers",
      title: `${topic} usage`,
      reply: `Drew ${topic} cache usage: Client → App → ${topic}, and a database read on miss.`,
      groups: [
        col("clients", "Clients", [node("client", "Client", "rectangle")]),
        col("application", "Application", [node("app", "App", "rectangle")]),
        col("cache", "Cache", [node("store", topic, "cylinder")]),
        col("data", "Data", [node("db", "Database", "cylinder")]),
      ],
      edges: [
        edge("client", "app", "Request"),
        edge("app", "store", "GET / SET"),
        edge("app", "db", "Read on miss", true),
      ],
    };
  }
  const sink = /\b(storage|bucket|blob|object store)\b/i.test(blob) ? "Storage" : "Database";
  return {
    kind: "layers",
    title: `${topic} usage`,
    reply: `Drew ${topic} between a client and ${sink.toLowerCase()}.`,
    groups: [
      col("clients", "Clients", [node("client", "Client", "rectangle")]),
      col("system", topic, [node("topic", topic, "rectangle")]),
      col("data", "Data", [node("sink", sink, "cylinder")]),
    ],
    edges: [
      edge("client", "topic", "Request"),
      edge("topic", "sink", sink === "Storage" ? "Put / Get" : "Read / write"),
    ],
  };
}

function isOauth(text: string): boolean {
  return /\boauth2?\b|\boidc\b|\bopenid\b|\bauthorization code\b|\bsso\b/i.test(text);
}

function isCheckout(text: string): boolean {
  if (/\b(checkout|shopping cart)\b/i.test(text)) return true;
  return /\bsequence\b/i.test(text) && /\b(place an order|payment)\b/i.test(text);
}

function isCacheAside(text: string): boolean {
  return /\bcache[\s-]?aside\b|\blook[\s-]?aside\b|\bcache architecture\b/i.test(text);
}

function isRichWebTiers(text: string): boolean {
  if (!TIER_RE.test(text)) return false;
  return /\bcdn\b/i.test(text) && /\bload[\s-]?balanc/i.test(text) && /\b(database|db)\b/i.test(text);
}

function isApiSequence(text: string): boolean {
  if (!/\bsequence\b/i.test(text)) return false;
  if (/\b(login|log[\s-]?in|sign[\s-]?in|oauth|checkout|cache)\b/i.test(text)) return false;
  return /\b(api|http|rest|rpc)\b/i.test(text);
}

function isApproval(text: string): boolean {
  if (/\b(tax|irs|1040)\b/i.test(text)) return false;
  return /\b(approval|approve|expense|purchase request|business process)\b/i.test(text);
}

function isStateMachine(text: string): boolean {
  return /\b(state machine|state diagram|lifecycle|uml state)\b/i.test(text);
}

function isEr(text: string): boolean {
  return /\b(data model|entity[- ]relationship|\ber diagram\b|schema diagram)\b/i.test(text);
}

function isCqrs(text: string): boolean {
  return /\bcqrs\b|\bcommand[- ]query\b/i.test(text);
}

function isEventDriven(text: string): boolean {
  if (/\bsequence\b/i.test(text)) return false;
  return /\bevent[- ]driven\b|\bpub(?:\/|\s)?sub\b|\bmessage bus\b|\bkafka\b/i.test(text);
}

function isMicroservices(text: string): boolean {
  return /\bmicro-?services?\b/i.test(text);
}

function isCloud(text: string): boolean {
  return (
    /\b(vpc|aws|amazon web services)\b/i.test(text) ||
    /\bcloud architecture\b/i.test(text) ||
    (/\balb\b/i.test(text) && /\b(ecs|rds|fargate)\b/i.test(text))
  );
}

function isKubernetes(text: string): boolean {
  return /\bkubernetes\b|\bk8s\b|\bkube\b/i.test(text);
}

function isDmz(text: string): boolean {
  return /\bdmz\b/i.test(text) || (/\bfirewall\b/i.test(text) && /\b(network|perimeter|zone)\b/i.test(text));
}

function isCdn(text: string): boolean {
  return /\bcdn\b|\bcontent delivery\b/i.test(text);
}

function isLoadBalancer(text: string): boolean {
  if (isCloud(text)) return false;
  return /\bload[\s-]?balanc/i.test(text);
}

function isSystemArchitecture(text: string): boolean {
  return /\b(system architecture|application architecture|web app architecture|api architecture|service architecture)\b/i.test(text);
}

function oauthSequence(): TemplateMatch {
  const participants: SequenceParticipant[] = [
    { id: "user", label: "User", shape: "actor" },
    { id: "browser", label: "Browser", shape: "rectangle" },
    { id: "app", label: "App", shape: "rectangle" },
    { id: "auth", label: "Auth server", shape: "rectangle" },
  ];
  const messages: SequenceMessage[] = [
    { from: "user", to: "browser", label: "Click login" },
    { from: "browser", to: "app", label: "GET /login" },
    { from: "app", to: "browser", label: "Redirect", dashed: true },
    { from: "browser", to: "auth", label: "Authorize" },
    { from: "auth", to: "browser", label: "Code", dashed: true },
    { from: "browser", to: "app", label: "Callback" },
    { from: "app", to: "auth", label: "Exchange code" },
    { from: "auth", to: "app", label: "Access token", dashed: true },
    { from: "app", to: "browser", label: "Session", dashed: true },
    { from: "browser", to: "user", label: "Logged in", dashed: true },
  ];
  return {
    context: "OAuth authorization-code login: the browser carries the redirect, and the app exchanges the code for a token.",
    spec: sequence(
      "OAuth login",
      "Drew an OAuth login sequence: User, Browser, App, and Auth server.",
      participants,
      messages,
    ),
  };
}

function checkoutSequence(): TemplateMatch {
  return {
    context: "Checkout charges a payment provider, then writes the order, and only then confirms to the shopper.",
    spec: sequence(
      "Checkout",
      "Drew a checkout sequence: User, Browser, Checkout, Payment, and Orders.",
      [
        { id: "user", label: "User", shape: "actor" },
        { id: "browser", label: "Browser", shape: "rectangle" },
        { id: "checkout", label: "Checkout", shape: "rectangle" },
        { id: "payment", label: "Payment", shape: "rectangle" },
        { id: "orders", label: "Orders", shape: "rectangle" },
      ],
      [
        { from: "user", to: "browser", label: "Place order" },
        { from: "browser", to: "checkout", label: "POST /checkout" },
        { from: "checkout", to: "payment", label: "Charge" },
        { from: "payment", to: "checkout", label: "Approved", dashed: true },
        { from: "checkout", to: "orders", label: "Save order" },
        { from: "orders", to: "checkout", label: "Saved", dashed: true },
        { from: "checkout", to: "browser", label: "Confirmation", dashed: true },
        { from: "browser", to: "user", label: "Receipt", dashed: true },
      ],
    ),
  };
}

function cacheAsideSequence(text: string): TemplateMatch {
  if (/\bredis\b/i.test(text)) {
    return {
      context:
        "Cache-aside checks Redis first. A hit returns from Redis. A miss loads the primary database and writes the value back.",
      spec: sequence(
        "Redis cache-aside",
        "Drew Redis cache-aside: a hit returns from Redis, and a miss loads the database then populates Redis.",
        [
          { id: "client", label: "Client", shape: "rectangle" },
          { id: "app", label: "Application servers", shape: "rectangle" },
          { id: "cache", label: "Redis", shape: "rectangle" },
          { id: "db", label: "Primary database", shape: "rectangle" },
        ],
        [
          { from: "client", to: "app", label: "Request" },
          { from: "app", to: "cache", label: "GET" },
          { from: "cache", to: "app", label: "Hit" },
          { from: "app", to: "client", label: "Return hit", dashed: true },
          { from: "cache", to: "app", label: "Miss", dashed: true },
          { from: "app", to: "db", label: "Load" },
          { from: "db", to: "app", label: "Value", dashed: true },
          { from: "app", to: "cache", label: "Populate" },
          { from: "app", to: "client", label: "Response", dashed: true },
        ],
      ),
    };
  }
  return {
    context: "Cache-aside reads the cache first. On a miss the app loads the database and writes the value back.",
    spec: sequence(
      "Cache-aside",
      "Drew cache-aside: the app checks the cache, loads the database on a miss, and stores the value.",
      [
        { id: "client", label: "Client", shape: "rectangle" },
        { id: "app", label: "App", shape: "rectangle" },
        { id: "cache", label: "Cache", shape: "rectangle" },
        { id: "db", label: "Database", shape: "rectangle" },
      ],
      [
        { from: "client", to: "app", label: "Request" },
        { from: "app", to: "cache", label: "GET" },
        { from: "cache", to: "app", label: "Miss", dashed: true },
        { from: "app", to: "db", label: "Load" },
        { from: "db", to: "app", label: "Value", dashed: true },
        { from: "app", to: "cache", label: "SET" },
        { from: "app", to: "client", label: "Response", dashed: true },
      ],
    ),
  };
}

function apiSequence(): TemplateMatch {
  return {
    context: "An API call is accepted at the edge, handled by a service, and answered from the database.",
    spec: sequence(
      "API call",
      "Drew an API call sequence: Client, API, Service, and Database.",
      [
        { id: "client", label: "Client", shape: "rectangle" },
        { id: "api", label: "API", shape: "rectangle" },
        { id: "service", label: "Service", shape: "rectangle" },
        { id: "db", label: "Database", shape: "rectangle" },
      ],
      [
        { from: "client", to: "api", label: "HTTP request" },
        { from: "api", to: "service", label: "Call" },
        { from: "service", to: "db", label: "Query" },
        { from: "db", to: "service", label: "Rows", dashed: true },
        { from: "service", to: "api", label: "Result", dashed: true },
        { from: "api", to: "client", label: "HTTP 200", dashed: true },
      ],
    ),
  };
}

function approvalWorkflow(text: string): TemplateMatch {
  const business = /\bbusiness process\b/i.test(text) && !/\b(approval|approve|expense|purchase)\b/i.test(text);
  const title = business ? "Business process" : "Approval";
  return {
    context: "An approval waits on a reviewer, then completes or stops on the reject branch.",
    spec: {
      kind: "workflow",
      title,
      reply: business
        ? "Drew a business process from submit through review to complete or rejected."
        : "Drew an approval workflow: submit, manager review, then complete or rejected.",
      nodes: [
        { id: "submit", label: "Submit request", shape: "document", column: 0, row: 0 },
        { id: "review", label: "Manager review", shape: "diamond", column: 1, row: 0 },
        { id: "approved", label: "Approved", shape: "rectangle", column: 2, row: -1 },
        { id: "rejected", label: "Rejected", shape: "rectangle", column: 2, row: 1 },
        { id: "done", label: "Complete", shape: "rectangle", column: 3, row: -1 },
      ],
      edges: [
        { from: "submit", to: "review" },
        { from: "review", to: "approved", label: "Yes", exit: "top" },
        { from: "review", to: "rejected", label: "No", exit: "bottom" },
        { from: "approved", to: "done" },
      ],
    } satisfies WorkflowSpec,
  };
}

function stateMachine(text: string): TemplateMatch {
  if (/\b(login|session|auth)\b/i.test(text)) {
    return {
      context: "A session moves from logged out, through a challenge, to signed in, and can expire.",
      spec: {
        kind: "workflow",
        title: "Login state",
        reply: "Drew a login state machine from logged out to signed in, with an expired session.",
        nodes: [
          { id: "out", label: "Logged out", shape: "rectangle", column: 0, row: 0 },
          { id: "challenge", label: "Challenge", shape: "rectangle", column: 1, row: 0 },
          { id: "in", label: "Signed in", shape: "rectangle", column: 2, row: 0 },
          { id: "expired", label: "Expired", shape: "rectangle", column: 2, row: 1 },
        ],
        edges: [
          { from: "out", to: "challenge", label: "Submit" },
          { from: "challenge", to: "in", label: "Accept" },
          { from: "in", to: "expired", label: "Timeout", exit: "bottom" },
        ],
      },
    };
  }
  if (/\b(order|checkout|ship|fulfill)/i.test(text)) {
    return {
      context: "An order is placed, paid, shipped, and delivered. It can be cancelled before payment or refunded after.",
      spec: {
        kind: "workflow",
        title: "Order lifecycle",
        reply: "Drew an order state machine from placed through delivered, with cancel and refund.",
        nodes: [
          { id: "placed", label: "Placed", shape: "rectangle", column: 0, row: 0 },
          { id: "paid", label: "Paid", shape: "rectangle", column: 1, row: 0 },
          { id: "shipped", label: "Shipped", shape: "rectangle", column: 2, row: 0 },
          { id: "delivered", label: "Delivered", shape: "rectangle", column: 3, row: 0 },
          { id: "cancelled", label: "Cancelled", shape: "rectangle", column: 0, row: 1 },
          { id: "refunded", label: "Refunded", shape: "rectangle", column: 1, row: 1 },
        ],
        edges: [
          { from: "placed", to: "paid", label: "Pay" },
          { from: "paid", to: "shipped", label: "Ship" },
          { from: "shipped", to: "delivered", label: "Deliver" },
          { from: "placed", to: "cancelled", label: "Cancel", exit: "bottom" },
          { from: "paid", to: "refunded", label: "Refund", exit: "bottom" },
        ],
      },
    };
  }
  return {
    context: "A document waits in draft, is reviewed, and is either published or rejected.",
    spec: {
      kind: "workflow",
      title: "Document lifecycle",
      reply: "Drew a document state machine from draft through review to published or rejected.",
      nodes: [
        { id: "draft", label: "Draft", shape: "rectangle", column: 0, row: 0 },
        { id: "review", label: "Review", shape: "rectangle", column: 1, row: 0 },
        { id: "published", label: "Published", shape: "rectangle", column: 2, row: 0 },
        { id: "rejected", label: "Rejected", shape: "rectangle", column: 1, row: 1 },
      ],
      edges: [
        { from: "draft", to: "review", label: "Submit" },
        { from: "review", to: "published", label: "Approve" },
        { from: "review", to: "rejected", label: "Reject", exit: "bottom" },
      ],
    },
  };
}

function erDiagram(text: string): TemplateMatch {
  if (/\b(blog|post|comment)\b/i.test(text)) {
    return {
      context: "A blog data model: a user writes posts, posts have comments, and posts carry tags.",
      spec: {
        kind: "workflow",
        title: "Blog data model",
        reply: "Drew a blog data model: User, Post, Comment, and Tag.",
        nodes: [
          { id: "user", label: "User", shape: "rectangle", column: 0, row: 0 },
          { id: "post", label: "Post", shape: "rectangle", column: 1, row: 0 },
          { id: "comment", label: "Comment", shape: "rectangle", column: 2, row: 0 },
          { id: "tag", label: "Tag", shape: "rectangle", column: 1, row: 1 },
        ],
        edges: [
          { from: "user", to: "post", label: "writes" },
          { from: "post", to: "comment", label: "has" },
          { from: "post", to: "tag", label: "tagged", exit: "bottom" },
        ],
      },
    };
  }
  return {
    context: "A commerce data model: a customer places orders, orders contain line items for products, and a payment settles the order.",
    spec: {
      kind: "workflow",
      title: "Commerce data model",
      reply: "Drew a commerce data model: Customer, Order, Line item, Product, and Payment.",
      nodes: [
        { id: "customer", label: "Customer", shape: "rectangle", column: 0, row: 0 },
        { id: "order", label: "Order", shape: "rectangle", column: 1, row: 0 },
        { id: "item", label: "Line item", shape: "rectangle", column: 2, row: 0 },
        { id: "product", label: "Product", shape: "rectangle", column: 3, row: 0 },
        { id: "payment", label: "Payment", shape: "rectangle", column: 1, row: 1 },
      ],
      edges: [
        { from: "customer", to: "order", label: "places" },
        { from: "order", to: "item", label: "contains" },
        { from: "item", to: "product", label: "for" },
        { from: "order", to: "payment", label: "paid with", exit: "bottom" },
      ],
    },
  };
}

function cqrs(): TemplateMatch {
  return {
    context: "CQRS splits commands that write from queries that read. Each side has its own store.",
    spec: {
      kind: "workflow",
      title: "CQRS",
      reply: "Drew CQRS: commands write to the write store and queries read from the read store.",
      nodes: [
        { id: "client", label: "Client", shape: "rectangle", column: 0, row: 0 },
        { id: "api", label: "API", shape: "rectangle", column: 1, row: 0 },
        { id: "commands", label: "Commands", shape: "rectangle", column: 2, row: -1 },
        { id: "queries", label: "Queries", shape: "rectangle", column: 2, row: 1 },
        { id: "write", label: "Write DB", shape: "cylinder", column: 3, row: -1 },
        { id: "read", label: "Read DB", shape: "cylinder", column: 3, row: 1 },
      ],
      edges: [
        { from: "client", to: "api" },
        { from: "api", to: "commands", label: "Command", exit: "top" },
        { from: "api", to: "queries", label: "Query", exit: "bottom" },
        { from: "commands", to: "write" },
        { from: "queries", to: "read" },
      ],
    },
  };
}

function eventDriven(text: string): TemplateMatch {
  const kafka = /\bkafka\b/i.test(text);
  const bus = kafka ? "Kafka" : "Event broker";
  return {
    context: kafka
      ? "Producers publish to Kafka. Consumers read the log on their own."
      : "Producers publish to a broker. Consumers handle the events on their own.",
    spec: layers(
      kafka ? "Kafka" : "Event-driven",
      kafka
        ? "Drew Kafka between web and worker producers and billing and mail consumers."
        : "Drew an event-driven architecture: producers publish to a broker, and consumers deliver the work.",
      [
        row("producers", "Producers", [node("web", "Web", "rectangle"), node("worker", "Worker", "rectangle")]),
        col("bus", "Bus", [node("broker", bus, "queue")]),
        row("consumers", "Consumers", [node("billing", "Billing", "rectangle"), node("mail", "Mail", "rectangle")]),
      ],
      [
        edge("web", "broker", "Publish"),
        edge("worker", "broker", "Publish"),
        edge("broker", "billing", "Deliver"),
        edge("broker", "mail", "Deliver"),
      ],
    ),
  };
}

function microservices(): TemplateMatch {
  return {
    context: "A gateway routes to independent services. Each service owns its database.",
    spec: layers(
      "Microservices",
      "Drew microservices: a gateway in front of Orders, Catalog, and Payments, each with its own database.",
      [
        col("clients", "Clients", [node("client", "Client", "rectangle")]),
        col("edge", "Edge", [node("gateway", "API Gateway", "hexagon")]),
        row("services", "Services", [
          node("orders", "Orders", "rectangle"),
          node("catalog", "Catalog", "rectangle"),
          node("payments", "Payments", "rectangle"),
        ]),
        row("data", "Data", [
          node("ordersDb", "Orders DB", "cylinder"),
          node("catalogDb", "Catalog DB", "cylinder"),
          node("paymentsDb", "Payments DB", "cylinder"),
        ]),
      ],
      [
        edge("client", "gateway", "HTTPS"),
        edge("gateway", "orders", "Route"),
        edge("gateway", "catalog", "Route"),
        edge("gateway", "payments", "Route"),
        edge("orders", "ordersDb", "SQL"),
        edge("catalog", "catalogDb", "SQL"),
        edge("payments", "paymentsDb", "SQL"),
      ],
    ),
  };
}

function isDetailedVpc(text: string): boolean {
  return /\b(internet gateway|\bigw\b|\bnat\b)/i.test(text);
}

function cloudVpc(text: string): TemplateMatch {
  if (isDetailedVpc(text)) return detailedVpc();
  return {
    context: "A public load balancer forwards into a private compute tier, which reads a managed database.",
    spec: layers(
      "AWS VPC",
      "Drew an AWS VPC: Internet → ALB → ECS → RDS.",
      [
        col("edge", "Edge", [node("internet", "Internet", "cloud")]),
        col("public", "Public subnet", [node("alb", "ALB", "hexagon")]),
        col("private", "Private subnet", [node("ecs", "ECS", "rectangle")]),
        col("data", "Data subnet", [node("rds", "RDS", "cylinder")]),
      ],
      [
        edge("internet", "alb", "HTTPS"),
        edge("alb", "ecs", "HTTP"),
        edge("ecs", "rds", "SQL"),
      ],
    ),
  };
}

function detailedVpc(): TemplateMatch {
  const spec = layers(
    "AWS VPC",
    "Drew an AWS VPC with an Internet Gateway, public and private subnets, NAT, an Application Load Balancer, ECS, and RDS.",
    [
      col("internet", "Internet", [node("net", "Internet", "cloud")]),
      col("igw", "Gateway", [node("igw", "Internet Gateway", "cloud")]),
      row("public", "Public subnet", [
        node("nat", "NAT", "hexagon"),
        node("alb", "Application Load Balancer", "hexagon"),
      ]),
      col("private", "Private subnet", [node("ecs", "ECS", "rectangle")]),
      col("data", "Private data subnet", [node("rds", "RDS", "cylinder")]),
    ],
    [
      edge("net", "igw", "Ingress"),
      edge("igw", "alb", "HTTPS"),
      edge("alb", "ecs", "Forward"),
      edge("ecs", "rds", "SQL"),
      edge("ecs", "nat", "Outbound"),
      edge("nat", "igw", "Egress"),
    ],
  );
  spec.enclosure = { id: "vpc", label: "VPC", groups: ["igw", "public", "private", "data"] };
  return {
    context:
      "Traffic enters the VPC through an Internet Gateway. The load balancer is public, ECS and RDS stay private, and NAT carries outbound traffic.",
    spec,
  };
}

function richWebTiers(): TemplateMatch {
  return {
    context:
      "A 3-tier web application puts browser clients and a CDN in the presentation tier, a load balancer and app servers in the application tier, and a database in the data tier.",
    spec: layers(
      "3-tier web application",
      "Drew a 3-tier web application with presentation, application, and data tiers.",
      [
        row("presentation", "Presentation tier", [
          node("browser", "Browser", "rectangle"),
          node("cdn", "CDN", "rectangle"),
        ]),
        row("application", "Application tier", [
          node("lb", "Load balancer", "hexagon"),
          node("servers", "Web/app servers", "rectangle"),
        ]),
        col("data", "Data tier", [node("db", "Database", "cylinder")]),
      ],
      [
        edge("browser", "cdn", "Request"),
        edge("cdn", "lb", "HTTPS"),
        edge("lb", "servers", "Forward"),
        edge("servers", "db", "SQL"),
      ],
    ),
  };
}

function kubernetes(): TemplateMatch {
  return {
    context:
      "Ingress enters the cluster, a Service selects the pods, and a Deployment keeps those pods running. A volume holds state.",
    spec: layers(
      "Kubernetes",
      "Drew a Kubernetes deploy: User → Ingress → Service → Deployment → pods, with a volume.",
      [
        col("clients", "Clients", [node("user", "User", "rectangle")]),
        col("edge", "Edge", [node("ingress", "Ingress", "hexagon")]),
        col("svc", "Service", [node("service", "Service", "rectangle")]),
        col("deploy", "Deployment", [node("deployment", "Deployment", "rectangle")]),
        row("pods", "Pods", [node("podA", "Pod A", "rectangle"), node("podB", "Pod B", "rectangle")]),
        col("storage", "Storage", [node("volume", "Volume", "cylinder")]),
      ],
      [
        edge("user", "ingress", "HTTPS"),
        edge("ingress", "service", "Route"),
        edge("service", "deployment", "Forward"),
        edge("deployment", "podA", "Run"),
        edge("deployment", "podB", "Run"),
        edge("podA", "volume", "Mount"),
        edge("podB", "volume", "Mount"),
      ],
    ),
  };
}

function dmz(): TemplateMatch {
  return {
    context: "A firewall admits traffic into a DMZ. Only the web server calls through to the private app and database.",
    spec: layers(
      "DMZ",
      "Drew a DMZ: Internet, firewall, web server and bastion, then the private app and database.",
      [
        col("internet", "Internet", [node("net", "Internet", "cloud")]),
        col("perimeter", "Perimeter", [node("fw", "Firewall", "hexagon")]),
        row("dmz", "DMZ", [node("web", "Web server", "rectangle"), node("bastion", "Bastion", "rectangle")]),
        col("internal", "Internal", [node("app", "App server", "rectangle")]),
        col("private", "Private", [node("db", "Database", "cylinder")]),
      ],
      [
        edge("net", "fw", "Inbound"),
        edge("fw", "web", "Allow"),
        edge("fw", "bastion", "Allow"),
        edge("web", "app", "Proxy"),
        edge("app", "db", "SQL"),
      ],
    ),
  };
}

function cdn(): TemplateMatch {
  return {
    context: "A CDN answers from the edge. A miss fetches the origin, which reads object storage.",
    spec: layers(
      "CDN",
      "Drew a CDN: the browser hits the edge cache, and a miss falls through to the origin.",
      [
        col("clients", "Clients", [node("browser", "Browser", "rectangle")]),
        col("edge", "Edge", [node("cdn", "CDN", "rectangle")]),
        col("origin", "Origin", [node("origin", "Origin", "rectangle")]),
        col("data", "Storage", [node("storage", "Object storage", "cylinder")]),
      ],
      [
        edge("browser", "cdn", "GET"),
        edge("cdn", "origin", "Miss", true),
        edge("origin", "storage", "Read"),
      ],
    ),
  };
}

function loadBalancer(): TemplateMatch {
  return {
    context: "A load balancer spreads requests across app instances that share one database.",
    spec: layers(
      "Load balancer",
      "Drew a load balancer in front of two app servers and a database.",
      [
        col("clients", "Clients", [node("client", "Client", "rectangle")]),
        col("edge", "Edge", [node("lb", "Load balancer", "hexagon")]),
        row("apps", "Applications", [node("a", "App A", "rectangle"), node("b", "App B", "rectangle")]),
        col("data", "Data", [node("db", "Database", "cylinder")]),
      ],
      [
        edge("client", "lb", "Request"),
        edge("lb", "a", "Forward"),
        edge("lb", "b", "Forward"),
        edge("a", "db", "SQL"),
        edge("b", "db", "SQL"),
      ],
    ),
  };
}

function systemArchitecture(text: string): TemplateMatch {
  const api = /\bapi architecture\b/i.test(text);
  return {
    context: api
      ? "An API architecture accepts the call at a gateway, runs it in a service, and reads a database."
      : "A system architecture is a client, a web tier, an API, and a database.",
    spec: api
      ? layers(
          "API architecture",
          "Drew an API architecture: Client → API Gateway → Service → Database.",
          [
            col("clients", "Clients", [node("client", "Client", "rectangle")]),
            col("edge", "Edge", [node("gateway", "API Gateway", "hexagon")]),
            col("service", "Service", [node("service", "Service", "rectangle")]),
            col("data", "Data", [node("db", "Database", "cylinder")]),
          ],
          [
            edge("client", "gateway", "HTTPS"),
            edge("gateway", "service", "Call"),
            edge("service", "db", "SQL"),
          ],
        )
      : layers(
          "System architecture",
          "Drew a system architecture: Browser → Web → API → Database.",
          [
            col("clients", "Clients", [node("browser", "Browser", "rectangle")]),
            col("web", "Web", [node("web", "Web", "rectangle")]),
            col("api", "API", [node("api", "API", "rectangle")]),
            col("data", "Data", [node("db", "Database", "cylinder")]),
          ],
          [
            edge("browser", "web", "HTTPS"),
            edge("web", "api", "Call"),
            edge("api", "db", "SQL"),
          ],
        ),
  };
}

function sequence(
  title: string,
  reply: string,
  participants: SequenceParticipant[],
  messages: SequenceMessage[],
): SequenceSpec {
  return { kind: "sequence", title, reply, participants, messages };
}

function layers(title: string, reply: string, groups: LayerGroup[], edges: LayerEdge[]): LayerSpec {
  return { kind: "layers", title, reply, groups, edges };
}

function col(id: string, label: string, nodes: LayerNode[]): LayerGroup {
  return { id, label, nodes, flow: "column" };
}

function row(id: string, label: string, nodes: LayerNode[]): LayerGroup {
  return { id, label, nodes, flow: "row" };
}

function node(id: string, label: string, shape: LayerNode["shape"]): LayerNode {
  return { id, label, shape };
}

function edge(from: string, to: string, label: string, side = false): LayerEdge {
  return side ? { from, to, label, side: true } : { from, to, label };
}
