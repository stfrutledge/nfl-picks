/**
 * Chart.js configurations and rendering
 * Ringer-inspired light theme
 */

let trendChart = null;
let standingsChart = null;
let trendChartZoomed = true;

/**
 * Destroy all chart instances to prevent memory leaks
 * Call this when navigating away from the dashboard view
 */
function destroyAllCharts() {
    if (trendChart) {
        trendChart.destroy();
        trendChart = null;
    }
    if (standingsChart) {
        standingsChart.destroy();
        standingsChart = null;
    }
}

const CHART_COLORS = {
    'Stephen': '#3b82f6',
    'Sean': '#00b112',
    'Dylan': '#8b5cf6',
    'Jason': '#f97316',
    'Daniel': '#06b6d4',
    'Cowherd': '#eab308'
};

/**
 * Get chart colors based on current theme
 */
function getChartColors() {
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    return {
        grid: isDark ? '#333333' : '#e5e5e5',
        text: isDark ? '#a0a0a0' : '#666666',
        tooltipBg: isDark ? '#2a2a2a' : '#1a1a1a',
        tooltipBorder: isDark ? '#444444' : '#333333'
    };
}

/**
 * Create or update the weekly trend line chart
 */
function renderTrendChart(weeklyData, category) {
    const ctx = document.getElementById('trend-chart').getContext('2d');
    const colors = getChartColors();

    // Determine which pickers to show
    const pickers = category === 'blazin' ? PICKERS_WITH_COWHERD : PICKERS;

    // Get all weeks
    const allWeeks = new Set();
    pickers.forEach(picker => {
        if (weeklyData[picker]) {
            weeklyData[picker].forEach(d => allWeeks.add(d.week));
        }
    });
    const weeks = Array.from(allWeeks).sort((a, b) => a - b);

    // Build datasets
    const datasets = pickers.map(picker => {
        const data = weeks.map(week => {
            const entry = weeklyData[picker]?.find(d => d.week === week);
            return entry ? entry.pct : null;
        });

        return {
            label: picker,
            data: data,
            borderColor: CHART_COLORS[picker],
            backgroundColor: CHART_COLORS[picker] + '20',
            borderWidth: 2.5,
            tension: 0.3,
            pointRadius: 3,
            pointHoverRadius: 5,
            fill: false
        };
    });

    // Destroy existing chart
    if (trendChart) {
        trendChart.destroy();
    }

    trendChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: weeks.map(w => `Wk ${w}`),
            datasets: datasets
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: {
                intersect: false,
                mode: 'index'
            },
            plugins: {
                legend: {
                    position: 'bottom',
                    labels: {
                        color: colors.text,
                        usePointStyle: true,
                        padding: 20,
                        font: {
                            family: "'Inter', sans-serif",
                            size: 11,
                            weight: '600'
                        }
                    }
                },
                tooltip: {
                    backgroundColor: colors.tooltipBg,
                    titleColor: '#ffffff',
                    bodyColor: '#999999',
                    borderColor: colors.tooltipBorder,
                    borderWidth: 1,
                    padding: 12,
                    titleFont: {
                        family: "'Inter', sans-serif",
                        weight: '600'
                    },
                    bodyFont: {
                        family: "'Inter', sans-serif"
                    },
                    itemSort: function(a, b) {
                        // Sort by value descending (highest percentage first)
                        return (b.parsed.y || 0) - (a.parsed.y || 0);
                    },
                    callbacks: {
                        label: function(context) {
                            return `${context.dataset.label}: ${context.parsed.y?.toFixed(2)}%`;
                        }
                    }
                }
            },
            scales: {
                x: {
                    grid: {
                        color: colors.grid
                    },
                    ticks: {
                        color: colors.text,
                        font: {
                            family: "'Inter', sans-serif",
                            size: 11
                        }
                    }
                },
                y: {
                    grid: {
                        color: colors.grid
                    },
                    ticks: {
                        color: colors.text,
                        font: {
                            family: "'Inter', sans-serif",
                            size: 11
                        },
                        callback: function(value) {
                            return value + '%';
                        }
                    },
                    min: trendChartZoomed ? 30 : 0,
                    max: trendChartZoomed ? 70 : 100
                }
            }
        }
    });

    // Setup zoom toggle button
    const zoomBtn = document.getElementById('toggle-trend-zoom');
    if (zoomBtn) {
        zoomBtn.onclick = () => {
            trendChartZoomed = !trendChartZoomed;
            zoomBtn.textContent = trendChartZoomed ? 'Zoom Out' : 'Zoom In';
            zoomBtn.classList.toggle('zoomed', !trendChartZoomed);

            // Update chart Y-axis
            if (trendChart) {
                trendChart.options.scales.y.min = trendChartZoomed ? 30 : 0;
                trendChart.options.scales.y.max = trendChartZoomed ? 70 : 100;
                trendChart.update();
            }
        };

        // Set initial button state
        zoomBtn.textContent = trendChartZoomed ? 'Zoom Out' : 'Zoom In';
        zoomBtn.classList.toggle('zoomed', !trendChartZoomed);
    }
}

/**
 * Create or update the favorites vs underdogs chart
 */
function renderFavUnderdogChart(favUnderdogData) {
    const ctx = document.getElementById('standings-chart').getContext('2d');
    const colors = getChartColors();

    if (!favUnderdogData || !favUnderdogData.favorites || !favUnderdogData.underdogs) {
        return;
    }

    const labels = PICKERS;
    const favData = labels.map(p => favUnderdogData.favorites[p]?.percentage || 0);
    const undData = labels.map(p => favUnderdogData.underdogs[p]?.percentage || 0);

    // Destroy existing chart
    if (standingsChart) {
        standingsChart.destroy();
    }

    standingsChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [
                {
                    label: 'Favorites',
                    data: favData,
                    backgroundColor: '#dc2626',
                    borderColor: '#dc2626',
                    borderWidth: 0,
                    borderRadius: 4
                },
                {
                    label: 'Underdogs',
                    data: undData,
                    backgroundColor: '#00b112',
                    borderColor: '#00b112',
                    borderWidth: 0,
                    borderRadius: 4
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    position: 'bottom',
                    labels: {
                        color: colors.text,
                        usePointStyle: true,
                        padding: 20,
                        font: {
                            family: "'Inter', sans-serif",
                            size: 11,
                            weight: '600'
                        }
                    }
                },
                tooltip: {
                    backgroundColor: colors.tooltipBg,
                    titleColor: '#ffffff',
                    bodyColor: '#999999',
                    borderColor: colors.tooltipBorder,
                    borderWidth: 1,
                    padding: 12,
                    titleFont: {
                        family: "'Inter', sans-serif",
                        weight: '600'
                    },
                    bodyFont: {
                        family: "'Inter', sans-serif"
                    },
                    callbacks: {
                        label: function(context) {
                            const picker = context.label;
                            const type = context.dataset.label.toLowerCase();
                            const data = type === 'favorites'
                                ? favUnderdogData.favorites[picker]
                                : favUnderdogData.underdogs[picker];
                            const record = data ? `${data.wins}-${data.losses}-${data.pushes}` : '';
                            return `${context.dataset.label}: ${context.parsed.y.toFixed(1)}% (${record})`;
                        }
                    }
                }
            },
            scales: {
                x: {
                    grid: {
                        display: false
                    },
                    ticks: {
                        color: colors.text,
                        font: {
                            family: "'Libre Franklin', sans-serif",
                            size: 11,
                            weight: '700'
                        }
                    }
                },
                y: {
                    grid: {
                        color: colors.grid
                    },
                    ticks: {
                        color: colors.text,
                        font: {
                            family: "'Inter', sans-serif",
                            size: 11
                        },
                        callback: function(value) {
                            return value + '%';
                        }
                    },
                    min: 40,
                    max: 60
                }
            }
        }
    });
}
