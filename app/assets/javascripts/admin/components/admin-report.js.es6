import { exportEntity } from "discourse/lib/export-csv";
import { outputExportResult } from "discourse/lib/export-result";
import { ajax } from "discourse/lib/ajax";
import Report from "admin/models/report";
import computed from "ember-addons/ember-computed-decorators";
import { registerTooltip, unregisterTooltip } from "discourse/lib/tooltip";

const TABLE_OPTIONS = {
  perPage: 8,
  total: true,
  limit: 20
};

const CHART_OPTIONS = {};

function collapseWeekly(data, average) {
  let aggregate = [];
  let bucket, i;
  let offset = data.length % 7;
  for (i = offset; i < data.length; i++) {
    if (bucket && i % 7 === offset) {
      if (average) {
        bucket.y = parseFloat((bucket.y / 7.0).toFixed(2));
      }
      aggregate.push(bucket);
      bucket = null;
    }

    bucket = bucket || { x: data[i].x, y: 0 };
    bucket.y += data[i].y;
  }
  return aggregate;
}

export default Ember.Component.extend({
  classNameBindings: [
    "isEnabled",
    "isLoading",
    "dasherizedDataSourceName",
    "currentMode"
  ],
  classNames: ["admin-report"],
  isEnabled: true,
  disabledLabel: "admin.dashboard.disabled",
  isLoading: false,
  dataSourceName: null,
  report: null,
  model: null,
  reportOptions: null,
  forcedModes: null,
  showAllReportsLink: false,
  startDate: null,
  endDate: null,
  showTrend: false,
  showHeader: true,
  showTitle: true,
  showFilteringUI: false,
  showCategoryOptions: Ember.computed.alias("model.category_filtering"),
  showDatesOptions: Ember.computed.alias("model.dates_filtering"),
  showGroupOptions: Ember.computed.alias("model.group_filtering"),
  showExport: Ember.computed.not("model.onlyTable"),
  hasFilteringActions: Ember.computed.or(
    "showCategoryOptions",
    "showDatesOptions",
    "showGroupOptions",
    "showExport"
  ),

  init() {
    this._super(...arguments);

    this._reports = [];
  },

  didReceiveAttrs() {
    this._super(...arguments);

    if (this.get("report")) {
      this._renderReport(
        this.get("report"),
        this.get("forcedModes"),
        this.get("currentMode")
      );
    } else if (this.get("dataSourceName")) {
      this._fetchReport().finally(() => this._computeReport());
    }
  },

  didRender() {
    this._super(...arguments);

    unregisterTooltip($(".info[data-tooltip]"));
    registerTooltip($(".info[data-tooltip]"));
  },

  willDestroyElement() {
    this._super(...arguments);

    unregisterTooltip($(".info[data-tooltip]"));
  },

  showTimeoutError: Ember.computed.alias("model.timeout"),

  @computed("dataSourceName", "model.type")
  dasherizedDataSourceName(dataSourceName, type) {
    return (dataSourceName || type || "undefined").replace(/_/g, "-");
  },

  @computed("dataSourceName", "model.type")
  dataSource(dataSourceName, type) {
    dataSourceName = dataSourceName || type;
    return `/admin/reports/${dataSourceName}`;
  },

  @computed("displayedModes.length")
  showModes(displayedModesLength) {
    return displayedModesLength > 1;
  },

  @computed("currentMode", "model.modes", "forcedModes")
  displayedModes(currentMode, reportModes, forcedModes) {
    const modes = forcedModes ? forcedModes.split(",") : reportModes;

    return Ember.makeArray(modes).map(mode => {
      const base = `mode-button ${mode}`;
      const cssClass = currentMode === mode ? `${base} current` : base;

      return {
        mode,
        cssClass,
        icon: mode === "table" ? "table" : "signal"
      };
    });
  },

  @computed()
  categoryOptions() {
    const arr = [{ name: I18n.t("category.all"), value: "all" }];
    return arr.concat(
      Discourse.Site.currentProp("sortedCategories").map(i => {
        return { name: i.get("name"), value: i.get("id") };
      })
    );
  },

  @computed()
  groupOptions() {
    const arr = [
      { name: I18n.t("admin.dashboard.reports.groups"), value: "all" }
    ];
    return arr.concat(
      this.site.groups.map(i => {
        return { name: i["name"], value: i["id"] };
      })
    );
  },

  @computed("currentMode")
  modeComponent(currentMode) {
    return `admin-report-${currentMode}`;
  },

  actions: {
    exportCsv() {
      exportEntity("report", {
        name: this.get("model.type"),
        start_date: this.get("startDate"),
        end_date: this.get("endDate"),
        category_id:
          this.get("categoryId") === "all" ? undefined : this.get("categoryId"),
        group_id:
          this.get("groupId") === "all" ? undefined : this.get("groupId")
      }).then(outputExportResult);
    },

    changeMode(mode) {
      this.set("currentMode", mode);
    }
  },

  _computeReport() {
    if (!this.element || this.isDestroying || this.isDestroyed) {
      return;
    }

    if (!this._reports || !this._reports.length) {
      return;
    }

    // on a slow network _fetchReport could be called multiple times between
    // T and T+x, and all the ajax responses would occur after T+(x+y)
    // to avoid any inconsistencies we filter by period and make sure
    // the array contains only unique values
    let filteredReports = this._reports.uniqBy("report_key");
    let report;

    const sort = r => {
      if (r.length > 1) {
        return r.findBy("type", this.get("dataSourceName"));
      } else {
        return r;
      }
    };

    let startDate = this.get("startDate");
    let endDate = this.get("endDate");

    startDate =
      startDate && typeof startDate.isValid === "function"
        ? startDate.format("YYYYMMDD")
        : startDate;
    endDate =
      startDate && typeof endDate.isValid === "function"
        ? endDate.format("YYYYMMDD")
        : endDate;

    if (!startDate || !endDate) {
      report = sort(filteredReports)[0];
    } else {
      let reportKey = `reports:${this.get("dataSourceName")}`;

      if (this.get("categoryId") && this.get("categoryId") !== "all") {
        reportKey += `:${this.get("categoryId")}`;
      } else {
        reportKey += `:`;
      }

      reportKey += `:${startDate.replace(/-/g, "")}`;
      reportKey += `:${endDate.replace(/-/g, "")}`;

      if (this.get("groupId") && this.get("groupId") !== "all") {
        reportKey += `:${this.get("groupId")}`;
      } else {
        reportKey += `:`;
      }

      reportKey += `:`;

      report = sort(
        filteredReports.filter(r => r.report_key.includes(reportKey))
      )[0];

      if (!report) {
        console.log(
          "failed to find a report to render",
          `expected key: ${reportKey}`,
          `existing keys: ${filteredReports.map(f => f.report_key)}`
        );
        return;
      }
    }

    this._renderReport(
      report,
      this.get("forcedModes"),
      this.get("currentMode")
    );
  },

  _renderReport(report, forcedModes, currentMode) {
    const modes = forcedModes ? forcedModes.split(",") : report.modes;
    currentMode = currentMode || modes[0];

    this.setProperties({
      model: report,
      currentMode,
      options: this._buildOptions(currentMode)
    });
  },

  _fetchReport() {
    this._super();

    this.set("isLoading", true);

    let payload = this._buildPayload(["prev_period"]);

    return ajax(this.get("dataSource"), payload)
      .then(response => {
        if (response && response.report) {
          this._reports.push(this._loadReport(response.report));
        } else {
          console.log("failed loading", this.get("dataSource"));
        }
      })
      .finally(() => {
        if (this.element && !this.isDestroying && !this.isDestroyed) {
          this.set("isLoading", false);
        }
      });
  },

  _buildPayload(facets) {
    let payload = { data: { cache: true, facets } };

    if (this.get("startDate")) {
      payload.data.start_date = moment(
        this.get("startDate"),
        "YYYY-MM-DD"
      ).format("YYYY-MM-DD[T]HH:mm:ss.SSSZZ");
    }

    if (this.get("endDate")) {
      payload.data.end_date = moment(this.get("endDate"), "YYYY-MM-DD").format(
        "YYYY-MM-DD[T]HH:mm:ss.SSSZZ"
      );
    }

    if (this.get("groupId") && this.get("groupId") !== "all") {
      payload.data.group_id = this.get("groupId");
    }

    if (this.get("categoryId") && this.get("categoryId") !== "all") {
      payload.data.category_id = this.get("categoryId");
    }

    if (this.get("reportOptions.table.limit")) {
      payload.data.limit = this.get("reportOptions.table.limit");
    }

    return payload;
  },

  _buildOptions(mode) {
    if (mode === "table") {
      const tableOptions = JSON.parse(JSON.stringify(TABLE_OPTIONS));
      return Ember.Object.create(
        _.assign(tableOptions, this.get("reportOptions.table") || {})
      );
    } else {
      const chartOptions = JSON.parse(JSON.stringify(CHART_OPTIONS));
      return Ember.Object.create(
        _.assign(chartOptions, this.get("reportOptions.chart") || {})
      );
    }
  },

  _loadReport(jsonReport) {
    Report.fillMissingDates(jsonReport, { filledField: "chartData" });

    if (jsonReport.chartData && jsonReport.chartData.length > 40) {
      jsonReport.chartData = collapseWeekly(
        jsonReport.chartData,
        jsonReport.average
      );
    }

    if (jsonReport.prev_data) {
      Report.fillMissingDates(jsonReport, {
        filledField: "prevChartData",
        dataField: "prev_data",
        starDate: jsonReport.prev_start_date,
        endDate: jsonReport.prev_end_date
      });

      if (jsonReport.prevChartData && jsonReport.prevChartData.length > 40) {
        jsonReport.prevChartData = collapseWeekly(
          jsonReport.prevChartData,
          jsonReport.average
        );
      }
    }

    return Report.create(jsonReport);
  }
});
