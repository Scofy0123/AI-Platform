import ReactMarkdown, { type Components, type UrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import "./SafeMarkdown.css";

interface SafeMarkdownProps {
  content: string;
}

const SAFE_COMPONENTS: Components = {
  h1: ({ node: _node, ...props }) => <h3 {...props} />,
  h2: ({ node: _node, ...props }) => <h4 {...props} />,
  h3: ({ node: _node, ...props }) => <h5 {...props} />,
  h4: ({ node: _node, ...props }) => <h6 {...props} />,
  h5: ({ node: _node, ...props }) => <h6 {...props} />,
  h6: ({ node: _node, ...props }) => <h6 {...props} />,
  a: ({ node: _node, href, children, ...props }) => {
    if (!isSafeLink(href)) {
      return <span className="safe-markdown-inert-link">{children}</span>;
    }
    return (
      <a href={href} rel="noopener noreferrer" target="_blank" {...props}>
        {children}
      </a>
    );
  },
  img: ({ node: _node, alt }) => (
    <span className="safe-markdown-image-placeholder" role="img" aria-label={imageLabel(alt)}>
      <span aria-hidden="true">▧</span>
      {alt || "图片"}
    </span>
  ),
};

const safeUrlTransform: UrlTransform = (url, key) => {
  if (key === "href" && isSafeLink(url)) {
    return url;
  }
  return null;
};

export function SafeMarkdown({ content }: SafeMarkdownProps) {
  return (
    <div className="safe-markdown">
      <ReactMarkdown
        components={SAFE_COMPONENTS}
        remarkPlugins={[remarkGfm]}
        skipHtml
        urlTransform={safeUrlTransform}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

function isSafeLink(href: string | undefined): href is string {
  if (!href) return false;
  try {
    const protocol = new URL(href).protocol;
    return protocol === "http:" || protocol === "https:" || protocol === "mailto:";
  } catch {
    return false;
  }
}

function imageLabel(alt: string | undefined): string {
  return `图片：${alt || "未命名图片"}`;
}
