const Airtable = require('airtable');
const GitHub = require('github-api');
const randomColor = require('random-color');

const gh = new GitHub({ token: process.env.GITHUB_API_KEY });

const issues = gh.getIssues(process.env.REPO_OWNER, process.env.REPO_NAME);
const airtable = new Airtable().base(process.env.AIRTABLE_BASE);

function name2Label(name) {
  return `proj:${name.toLowerCase().replace(/ /g, '-')}`;
}

async function syncProjectLabels() {
  const projId2Label = new Map((await issues.listLabels({ AcceptHeader: 'symmetra-preview' }))
    .data.map(label => [label.description, label.name]));

  const projects = (await airtable('Projects').select({
    fields: ['Name'],
    filterByFormula: '{GitHub} = 1',
  }).all());

  await Promise.all(projects.map(proj => {
    if (projId2Label.has(proj.id)) return;
    return issues.createLabel({
      name: name2Label(proj.get('Name')),
      color: randomColor().hexString().slice(1),
      description: proj.id,
      AcceptHeader: 'symmetra-preview',
    });
  }));

  return projId2Label;
}

module.exports.init = async (_event, _context) => {
  // delete all existing labels
  await Promise.all((await issues.listLabels({})).data
    .map(label => issues.deleteLabel(label.name)));

  return syncProjectLabels();
};

module.exports.transferTasks = async (_event, _context) => {
  const projId2Label = await syncProjectLabels();

  const openTasks = await airtable('Tasks').select({
    fields: ['Name', 'Notes', 'Time Estimate', 'Project'],
    view: 'Main View',
    filterByFormula: 'NOT({Status} = "done")',
  }).all();
  const openTaskNames = new Set(openTasks.map(task => task.get('Name')));

  const openIssues = (await issues.listIssues({ state: 'open' })).data;
  const openIssueTitles = new Set(openIssues.map(issue => issue.title));

  const createIssuesFromTasks = openTasks.map(task => {
    const name = task.get('Name');
    if (openIssueTitles.has(name)) return;

    const labels = task.get('Project')
      .map(projId => projId2Label.get(projId))
      .filter(label => label !== undefined);
    if (labels.length === 0) return;

    const desc = (task.get('Notes') || '').trim();
    let body = desc ? `**Description**: ${desc}\n\n` : '';
    body += `Time Estimate (days): ${task.get('Time Estimate')}`;
    body += `\n\n[Airtable link](${process.env.AIRTABLE_LINK_PRE}{$task.id})`;

    return issues.createIssue({ title: name, body, labels });
  });

  const closeCompletedTaskIssues = openIssues.map(issue => {
    if (openTaskNames.has(issue.title)) return;
    return issues.editIssue(issue.number, { state: 'closed' });
  });

  return Promise.all(createIssuesFromTasks.concat(closeCompletedTaskIssues));
};
