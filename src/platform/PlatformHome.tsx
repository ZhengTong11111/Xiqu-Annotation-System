import type { AnnotationProjectSummary } from "../../packages/shared/src/index";

type PlatformHomeProps = {
  projects: AnnotationProjectSummary[];
  isLoading: boolean;
  errorMessage: string | null;
};

export function PlatformHome({ projects, isLoading, errorMessage }: PlatformHomeProps) {
  return (
    <section className="platform-home">
      <header className="platform-home-header">
        <h1>昆曲多模态标注平台</h1>
        <p>统一管理视频、标注文档、课堂任务、版本和协同编辑。</p>
      </header>
      {isLoading ? <p>正在加载项目...</p> : null}
      {errorMessage ? <p role="alert">{errorMessage}</p> : null}
      {!isLoading && !errorMessage ? (
        <div className="platform-project-list">
          {projects.map((project) => (
            <article key={project.id} className="platform-project-card">
              <h2>{project.title}</h2>
              <p>{project.documentCount} 份标注文档</p>
              <small>更新时间：{project.updatedAt}</small>
            </article>
          ))}
          {projects.length === 0 ? <p>暂无可访问项目。</p> : null}
        </div>
      ) : null}
    </section>
  );
}
